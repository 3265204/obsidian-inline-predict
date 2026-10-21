/**
 * Editor observer: turns CodeMirror activity into `EditorSnapshot` values.
 *
 * The snapshot is the only thing the scheduler/controller know about the editor, so it must be
 * cheap (prefix/suffix are capped), defensive (callbacks can never throw into CM6) and honest
 * about document versions (monotonic per editor view, bumped once per doc-changing transaction).
 *
 * The public `createEditorObserver` API hides the view parameter. The completion controller
 * needs a view-aware variant so one extension definition can serve several editor views, which
 * is why the lower-level `createObserverExtension` is exported too.
 */

import type { EditorState, Extension, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { PREFIX_CAPTURE_CHARS, SUFFIX_CAPTURE_CHARS } from '../core/constants';
import { endsWithHighSurrogate, isLowSurrogate } from '../core/text';
import type { EditDelta, EditorMode, EditorSnapshot, SnapshotTrigger } from '../core/types';

export interface EditorDocInfo {
	docId: string;
	mode: EditorMode;
	language: string | null;
}

/** Required by the plugin wiring in `main.ts`. */
export interface EditorObserverOptions {
	getDocInfo(view: EditorView): EditorDocInfo;
	onSnapshot(snapshot: EditorSnapshot): void;
	onCursor(snapshot: EditorSnapshot): void;
	onComposition(composing: boolean): void;
	onDestroy(): void;
}

/**
 * View-aware observer callbacks. Unlike `EditorObserverOptions` these receive the `EditorView`,
 * so a single extension definition can route events to per-view consumers.
 */
export interface EditorObserverHandlers {
	getDocInfo(view: EditorView): EditorDocInfo;
	onSnapshot(view: EditorView, snapshot: EditorSnapshot): void;
	onCursor(view: EditorView, snapshot: EditorSnapshot): void;
	onComposition(view: EditorView, composing: boolean): void;
	onDestroy(view: EditorView): void;
	onInit?(view: EditorView): void;
	onFocus?(view: EditorView): void;
	onBlur?(view: EditorView): void;
}

const FALLBACK_DOC_INFO: EditorDocInfo = { docId: '', mode: 'source', language: null };

/** Callbacks originate in other modules; a throw there must never break editing. */
function callQuietly(action: () => void): void {
	try {
		action();
	} catch {
		// Intentionally ignored: see hard invariant "no throwing from editor extensions".
	}
}

/** First change of a transaction, in pre-transaction coordinates. */
function firstChange(tr: Transaction): EditDelta | null {
	let delta: EditDelta | null = null;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (delta !== null) return;
		delta = {
			from: fromA,
			to: toA,
			insertedText: inserted.toString(),
			removedLength: toA - fromA,
			at: Date.now(),
		};
	});
	return delta;
}

/**
 * Markdown fenced-code / math-block heuristic over the captured prefix. Line based on purpose:
 * a full Markdown parse would be far too expensive for every keystroke, and being off at the
 * very first line of a fenced block is acceptable for scheduling decisions.
 */
function scanBlocks(prefix: string): { inCodeBlock: boolean; inMathBlock: boolean } {
	let fence: { char: string; length: number } | null = null;
	let inMathBlock = false;
	for (const rawLine of prefix.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (fence !== null) {
			const close = /^(`{3,}|~{3,})$/.exec(line);
			if (close !== null && close[1] !== undefined) {
				const marker = close[1];
				if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
			}
			continue;
		}
		if (inMathBlock) {
			if (line.includes('$$')) inMathBlock = false;
			continue;
		}
		const open = /^(`{3,}|~{3,})/.exec(line);
		if (open !== null && open[1] !== undefined) {
			const marker = open[1];
			fence = { char: marker[0] ?? '`', length: marker.length };
			continue;
		}
		if (line.startsWith('$$') && !line.slice(2).includes('$$')) inMathBlock = true;
	}
	return { inCodeBlock: fence !== null, inMathBlock };
}

/** Build the immutable snapshot. Offsets are absolute; prefix/suffix are capped. */
function buildSnapshot(
	state: EditorState,
	info: EditorDocInfo,
	docVersion: number,
	composing: boolean,
	trigger: SnapshotTrigger,
	lastEdit: EditDelta | null,
): EditorSnapshot {
	const selection = state.selection.main;
	const cursor = selection.head;
	const line = state.doc.lineAt(cursor);
	const ch = cursor - line.from;

	const docLength = state.doc.length;
	let prefixStart = Math.max(0, cursor - PREFIX_CAPTURE_CHARS);
	let prefix = state.doc.sliceString(prefixStart, cursor);
	if (prefixStart > 0 && prefix.length > 0 && isLowSurrogate(prefix.charCodeAt(0))) {
		prefixStart -= 1;
		prefix = state.doc.sliceString(prefixStart, cursor);
	}

	let suffixEnd = Math.min(docLength, cursor + SUFFIX_CAPTURE_CHARS);
	let suffix = state.doc.sliceString(cursor, suffixEnd);
	if (suffixEnd < docLength && endsWithHighSurrogate(suffix)) {
		suffixEnd += 1;
		suffix = state.doc.sliceString(cursor, suffixEnd);
	}

	const blocks = scanBlocks(prefix);
	return {
		docId: info.docId,
		docVersion,
		cursor,
		selectionFrom: selection.from,
		selectionTo: selection.to,
		prefix,
		prefixOffset: prefixStart,
		suffix,
		line: line.number - 1,
		ch,
		lineTextBefore: line.text.slice(0, ch),
		lineTextAfter: line.text.slice(ch),
		isComposing: composing,
		timestamp: Date.now(),
		trigger,
		lastEdit,
		language: info.language,
		mode: info.mode,
		inCodeBlock: blocks.inCodeBlock,
		inMathBlock: blocks.inMathBlock,
	};
}

class ObserverPlugin {
	private docVersion = 0;
	private composing = false;
	private destroyed = false;
	private docId: string;
	private lastFocusState = false;

	constructor(
		private readonly view: EditorView,
		private readonly handlers: EditorObserverHandlers,
	) {
		this.docId = this.readInfo().docId;
		callQuietly(() => this.handlers.onInit?.(this.view));
		// The view is still being constructed here; defer the first snapshot so subscribers can
		// finish their own setup before receiving it.
		queueMicrotask(() => {
			if (this.destroyed) return;
			this.emit('file-open', null);
		});
	}

	private readInfo(): EditorDocInfo {
		try {
			return this.handlers.getDocInfo(this.view);
		} catch {
			return FALLBACK_DOC_INFO;
		}
	}

	private isComposing(): boolean {
		return this.composing || this.view.composing;
	}

	private emit(trigger: SnapshotTrigger, lastEdit: EditDelta | null): void {
		if (this.destroyed) return;
		const snapshot = buildSnapshot(
			this.view.state,
			this.readInfo(),
			this.docVersion,
			this.isComposing(),
			trigger,
			lastEdit,
		);
		callQuietly(() => this.handlers.onSnapshot(this.view, snapshot));
	}

	update(update: ViewUpdate): void {
		if (this.destroyed) return;
		let changedCount = 0;
		let lastEdit: EditDelta | null = null;
		for (const tr of update.transactions) {
			if (!tr.docChanged) continue;
			changedCount++;
			if (lastEdit === null) lastEdit = firstChange(tr);
		}
		if (changedCount > 0) {
			// One version bump per doc-changing transaction, so stale results never win.
			this.docVersion += changedCount;
			this.docId = this.readInfo().docId;
			this.emit('doc-change', lastEdit);
			return;
		}
		const info = this.readInfo();
		if (info.docId !== this.docId) {
			this.docId = info.docId;
			this.emit('file-open', null);
			return;
		}
		if (update.selectionSet) {
			const snapshot = buildSnapshot(
				this.view.state,
				info,
				this.docVersion,
				this.isComposing(),
				'selection',
				null,
			);
			callQuietly(() => this.handlers.onCursor(this.view, snapshot));
		}
	}

	startComposition(): void {
		if (this.destroyed || this.composing) return;
		this.composing = true;
		callQuietly(() => this.handlers.onComposition(this.view, true));
	}

	endComposition(): void {
		if (this.destroyed) return;
		this.composing = false;
		callQuietly(() => this.handlers.onComposition(this.view, false));
		const versionAtEnd = this.docVersion;
		// IME commit may not produce a transaction (e.g. composition ended without a change).
		// If it did, the doc-change snapshot already told the scheduler; otherwise emit here.
		queueMicrotask(() => {
			if (this.destroyed || this.docVersion !== versionAtEnd) return;
			this.emit('composition-end', null);
		});
	}

	handleFocus(): void {
		if (this.destroyed || this.lastFocusState) return;
		this.lastFocusState = true;
		callQuietly(() => this.handlers.onFocus?.(this.view));
	}

	handleBlur(): void {
		if (this.destroyed || !this.lastFocusState) return;
		this.lastFocusState = false;
		callQuietly(() => this.handlers.onBlur?.(this.view));
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		callQuietly(() => this.handlers.onDestroy(this.view));
	}
}

/** Low-level observer extension. Prefer `createEditorObserver` unless you need the view. */
export function createObserverExtension(handlers: EditorObserverHandlers): Extension {
	return ViewPlugin.define((view) => new ObserverPlugin(view, handlers), {
		eventObservers: {
			compositionstart() {
				this.startComposition();
			},
			compositionend() {
				this.endComposition();
			},
			focus() {
				this.handleFocus();
			},
			blur() {
				this.handleBlur();
			},
		},
	});
}

/** Required public API: a single-view observer with plain snapshot callbacks. */
export function createEditorObserver(options: EditorObserverOptions): Extension {
	return createObserverExtension({
		getDocInfo: (view) => options.getDocInfo(view),
		onSnapshot: (_view, snapshot) => options.onSnapshot(snapshot),
		onCursor: (_view, snapshot) => options.onCursor(snapshot),
		onComposition: (_view, composing) => options.onComposition(composing),
		onDestroy: () => options.onDestroy(),
	});
}
