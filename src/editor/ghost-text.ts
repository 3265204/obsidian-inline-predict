/**
 * Ghost-text extension: renders an `ActiveSuggestion` as non-editable decoration and provides
 * the Tab/Escape keymap.
 *
 * Three rules drive the design:
 * 1. Rendering never mutates the document — the ghost is an inline widget only.
 * 2. With no suggestion, Tab/Esc are not handled at all, so native indentation/escape runs.
 * 3. While an IME composition is active, the ghost is hidden and the keymap stays out of the way.
 *
 * The suggestion itself lives in a `StateField`; a second field derives the decoration set so
 * the composer field (IME) and the suggestion field can be combined without a view dependency.
 */

import {
	Facet,
	Prec,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
} from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	WidgetType,
	keymap,
} from '@codemirror/view';
import { GHOST_MAX_CHARS } from '../core/constants';
import { isHighSurrogate } from '../core/text';
import type { ActiveSuggestion } from '../core/types';
import { t } from '../i18n';

export interface GhostTextOptions {
	accept(): boolean;
	acceptWord(): boolean;
	acceptSentence(): boolean;
	acceptLine(): boolean;
	dismiss(): void;
}

/** Set/clear the visible suggestion. Exported for tests and controller wiring. */
export const setGhostSuggestionEffect = StateEffect.define<ActiveSuggestion | null>();

/** Set while the editor has an active IME composition. */
export const setComposingEffect = StateEffect.define<boolean>();

const ghostField = StateField.define<ActiveSuggestion | null>({
	create: () => null,
	update(value, tr) {
		if (tr.docChanged) {
			// Positions in `value` refer to the old document. The controller re-supplies a new
			// suggestion after the edit; rendering a mapped one could show the wrong text.
			return null;
		}
		let next = value;
		for (const effect of tr.effects) {
			if (effect.is(setGhostSuggestionEffect)) next = effect.value;
		}
		return next;
	},
});

const composingField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		let next = value;
		for (const effect of tr.effects) {
			if (effect.is(setComposingEffect)) next = effect.value;
		}
		return next;
	},
});

const decorationsField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, tr) {
		const affected = tr.effects.some(
			(effect) => effect.is(setGhostSuggestionEffect) || effect.is(setComposingEffect),
		);
		if (!tr.docChanged && !affected) return decorations;
		return buildDecorations(tr.state);
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** Holds the accept/dismiss callbacks for the active extension instance. */
const ghostOptionsFacet = Facet.define<GhostTextOptions, GhostTextOptions | null>({
	combine: (values) => (values.length === 0 ? null : (values[values.length - 1] ?? null)),
});

function buildDecorations(state: EditorState): DecorationSet {
	const suggestion = state.field(ghostField, false) ?? null;
	if (suggestion === null) return Decoration.none;
	if (state.field(composingField, false) ?? false) return Decoration.none;
	if (suggestion.remainingText.length === 0) return Decoration.none;
	const anchor = Math.max(0, Math.min(suggestion.anchor, state.doc.length));
	return Decoration.set(
		[Decoration.widget({ widget: new GhostWidget(suggestion.remainingText), side: 1 }).range(anchor)],
		true,
	);
}

/** Cap what is painted without slicing a surrogate pair in half. */
function capGhostText(text: string): string {
	if (text.length <= GHOST_MAX_CHARS) return text;
	let end = GHOST_MAX_CHARS;
	if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
	return text.slice(0, end);
}

class GhostWidget extends WidgetType {
	constructor(private readonly displayText: string) {
		super();
	}

	eq(other: GhostWidget): boolean {
		return other.displayText === this.displayText;
	}

	get lineBreaks(): number {
		let count = 0;
		for (const ch of this.displayText) if (ch === '\n') count++;
		return count;
	}

	toDOM(view: EditorView): HTMLElement {
		// 在编辑器所属文档创建灰字，避免弹出窗口引用主窗口的 DOM。
		const fragment = view.dom.ownerDocument.adoptNode(createFragment());
		const wrap = fragment.createSpan({ cls: 'predictive-ghost', text: this.displayText });

		// Touch/pointer accept chip; it must not take focus away from the editor.
		const chip = wrap.createSpan({ cls: 'predictive-ghost-accept' });
		chip.setAttribute('role', 'button');
		chip.setAttribute('aria-label', t('ghost.tapToAccept'));
		chip.setAttribute('tabindex', '-1');
		chip.textContent = t('ghost.acceptHint');
		chip.addEventListener('mousedown', (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		chip.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			view.state.facet(ghostOptionsFacet)?.accept();
		});
		return wrap;
	}
}

/** Read the current suggestion from the editor state. */
export function getGhostSuggestion(state: EditorState): ActiveSuggestion | null {
	return state.field(ghostField, false) ?? null;
}

function sameSuggestion(a: ActiveSuggestion | null, b: ActiveSuggestion | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	return (
		a.remainingText === b.remainingText &&
		a.anchor === b.anchor &&
		a.docVersion === b.docVersion &&
		a.candidate.requestId === b.candidate.requestId
	);
}

/**
 * Set or clear the visible suggestion. Invalid anchors are clamped here so a stale caller can
 * never make the decoration layer throw.
 *
 * Returns false when the transaction could not be dispatched, which happens when this is called
 * from inside a CM6 view update. Callers that can run there (the controller) retry later.
 */
export function trySetGhostSuggestion(
	view: EditorView,
	suggestion: ActiveSuggestion | null,
): boolean {
	let next = suggestion;
	if (next !== null) {
		const remainingText = capGhostText(next.remainingText);
		if (remainingText.length === 0) {
			next = null;
		} else {
			next = {
				...next,
				remainingText,
				anchor: Math.max(0, Math.min(next.anchor, view.state.doc.length)),
			};
		}
	}
	if (sameSuggestion(getGhostSuggestion(view.state), next)) return true;
	// A transaction during composition would abort the IME. The controller re-renders after the
	// composition ends (reconcile), so dropping this update is safe.
	if (view.composing) return false;
	try {
		view.dispatch({ effects: setGhostSuggestionEffect.of(next) });
		return true;
	} catch {
		// The view is destroyed, or an update is in progress.
		return false;
	}
}

/** Required public API: set or clear the visible suggestion. */
export function setGhostSuggestion(view: EditorView, suggestion: ActiveSuggestion | null): void {
	trySetGhostSuggestion(view, suggestion);
}

function isComposing(view: EditorView): boolean {
	// `view.composing` only becomes true after the first composition update (CM6 counts
	// composition updates); the DOM class is set synchronously on compositionstart and is the
	// reliable guard for keys pressed immediately after starting an IME composition.
	return (
		view.composing ||
		view.dom.classList.contains('predictive-composing') ||
		(view.state.field(composingField, false) ?? false)
	);
}

/**
 * Hide/show the ghost with a DOM class instead of a transaction.
 *
 * Dispatching any CodeMirror transaction during an active IME composition (especially in
 * `compositionstart`) can abort the composition or leave the IME with a stale selection: the
 * user picks a Chinese candidate and the committed text never reaches the document. Hiding is
 * therefore purely declarative CSS; the state field is only touched again after composition ends.
 */
function setComposingDom(view: EditorView, composing: boolean): void {
	const dom = view.dom;
	if (composing) dom.classList.add('predictive-composing');
	else dom.classList.remove('predictive-composing');
}

/** Observe IME composition without dispatching (dispatches during composition are unsafe). */
const compositionPlugin = ViewPlugin.define(() => ({}), {
	eventObservers: {
		compositionstart(_event, view) {
			setComposingDom(view, true);
		},
		compositionend(_event, view) {
			setComposingDom(view, false);
		},
		blur(_event, view) {
			// Safety net: some mobile keyboards drop compositionend when focus moves away.
			setComposingDom(view, false);
		},
	},
});

/** Extension factory. Add it once per editor configuration. */
export function createGhostTextExtension(options: GhostTextOptions): Extension {
	const acceptKeymap = keymap.of([
		{
			key: 'Tab',
			run: (view) => {
				if (isComposing(view)) return false;
				if (getGhostSuggestion(view.state) === null) return false;
				return options.accept();
			},
		},
		{
			key: 'Escape',
			run: (view) => {
				if (isComposing(view)) return false;
				if (getGhostSuggestion(view.state) === null) return false;
				options.dismiss();
				return true;
			},
		},
	]);

	return [
		ghostField,
		composingField,
		decorationsField,
		ghostOptionsFacet.of(options),
		Prec.highest(acceptKeymap),
		compositionPlugin,
	];
}
