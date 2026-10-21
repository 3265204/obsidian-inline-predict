/**
 * Per-editor completion session: the bridge between one editor view and its scheduler.
 *
 * It owns the scheduler instance for that view, forwards observer snapshots, renders scheduler
 * suggestions, and executes accept/dismiss commands.
 *
 * Staleness rules enforced here (on top of the scheduler's own request guards):
 * - a suggestion is only shown when it targets the newest snapshot's document version and cursor;
 * - a doc change that is not a continuation of the suggestion discards it (and reports "ignored");
 * - events arriving after `destroy()` are dropped.
 */

import type { EditorView } from '@codemirror/view';
import { isLowSurrogate } from '../core/text';
import { createWindowTimers } from '../core/timers';
import { applyAccept, type AcceptGranularity, type AcceptResult } from '../editor/accept';
import { trySetGhostSuggestion } from '../editor/ghost-text';
import { shouldDeferAutoRequest } from './context-gate';
import type {
	ActiveSuggestion,
	EditorSnapshot,
	SchedulerPort,
	SuggestionFeedback,
} from '../core/types';
import type { PredictiveSettings } from '../settings/schema';
import { DEFAULT_SETTINGS } from '../settings/schema';
import type { CompletionExtensionOptions } from './controller';

/** A suggestion nobody interacted with for this long is reported as ignored and dropped. */
const IGNORED_AFTER_MS = 8_000;

export class CompletionController {
	private suggestion: ActiveSuggestion | null = null;
	private latestSnapshot: EditorSnapshot | null = null;
	private scheduler: SchedulerPort | null = null;
	private destroyed = false;
	private composing = false;
	private suppressValidation = false;
	private cancelIgnoreTimer: (() => void) | null = null;
	private shownAt = 0;
	private paused = false;
	private renderGeneration = 0;
	private queuedRender: { value: ActiveSuggestion | null; generation: number } | null = null;
	private renderQueued = false;

	constructor(
		readonly view: EditorView,
		private readonly options: CompletionExtensionOptions,
	) {}

	attachScheduler(scheduler: SchedulerPort | null): void {
		this.scheduler = scheduler;
	}

	getSuggestion(): ActiveSuggestion | null {
		return this.suggestion;
	}

	handleSnapshot(snapshot: EditorSnapshot): void {
		if (this.destroyed) return;
		this.latestSnapshot = snapshot;
		this.composing = snapshot.isComposing;
		// 接受事务由下方统一推进调度状态，避免一次插入被消费两次。
		if (this.suppressValidation) return;
		const settings = this.readSettings();
		if (!settings.completion.enabled) {
			this.pauseScheduler(snapshot);
			return;
		}
		this.paused = false;
		if (!this.suppressValidation) this.validateSnapshot(snapshot, false);
		if (shouldDeferAutoRequest(snapshot, settings.completion)) {
			// Too little context to predict meaningfully: keep the scheduler's snapshot fresh, but
			// never spend a request. The next edits will re-evaluate this gate.
			this.callScheduler((scheduler) => scheduler.updateCursor(snapshot));
			return;
		}
		if (settings.completion.autoTrigger) {
			this.callScheduler((scheduler) => scheduler.update(snapshot));
		} else {
			// Manual mode: keep the scheduler's snapshot current but never let it auto-schedule.
			this.callScheduler((scheduler) => scheduler.updateCursor(snapshot));
		}
	}

	handleCursor(snapshot: EditorSnapshot): void {
		if (this.destroyed) return;
		this.latestSnapshot = snapshot;
		const settings = this.readSettings();
		if (!settings.completion.enabled) {
			this.pauseScheduler(snapshot);
			return;
		}
		this.paused = false;
		if (!this.suppressValidation) this.validateSnapshot(snapshot, true);
		this.callScheduler((scheduler) => scheduler.updateCursor(snapshot));
	}

	handleComposition(composing: boolean): void {
		if (this.destroyed) return;
		this.composing = composing;
		if (!composing) this.reconcileAfterComposition();
	}

	/**
	 * The composition may have inserted committed text (or not). If the ghost no longer starts at
	 * the cursor, drop it; the scheduler's composition-end snapshot will produce a fresh state.
	 */
	private reconcileAfterComposition(): void {
		const current = this.suggestion;
		if (current === null) return;
		const latest = this.latestSnapshot;
		const stillValid =
			latest !== null &&
			latest.docId === current.candidate.docId &&
			latest.cursor === current.anchor &&
			latest.docVersion === current.docVersion;
		if (!stillValid) this.clearSuggestion(null);
	}

	handleSuggestion(suggestion: ActiveSuggestion | null): void {
		if (this.destroyed) return;
		// Dispatching ghost state during an IME composition can abort the composition and lose the
		// committed text. The scheduler may emit `null` (it cleared its own state); ignore it here
		// and reconcile when composition ends.
		if (this.composing || this.view.composing) return;
		if (!this.readSettings().completion.enabled) {
			if (this.suggestion !== null) this.clearSuggestion(null);
			return;
		}
		if (suggestion === null) {
			if (this.suggestion !== null) this.clearSuggestion(null);
			return;
		}
		const latest = this.latestSnapshot;
		if (latest === null) return;
		if (this.composing || latest.isComposing) return;
		if (suggestion.remainingText.length === 0) return;
		if (suggestion.docVersion !== latest.docVersion) return;
		if (suggestion.candidate.docId !== latest.docId) return;
		// Late results are only valid at the cursor they were requested for.
		if (suggestion.anchor !== latest.cursor) return;
		this.suggestion = suggestion;
		this.shownAt = Date.now();
		this.render(suggestion);
		this.armIgnoreTimer();
	}

	requestNow(): boolean {
		if (this.destroyed || this.scheduler === null) return false;
		if (!this.readSettings().completion.enabled) return false;
		try {
			this.scheduler.requestNow();
			return true;
		} catch {
			return false;
		}
	}

	/** Settings changed at runtime: stop/clear immediately when completion was turned off. */
	refresh(): void {
		if (this.destroyed) return;
		const snapshot = this.latestSnapshot;
		if (!this.readSettings().completion.enabled) {
			if (snapshot !== null) this.pauseScheduler(snapshot);
			else if (this.suggestion !== null) this.clearSuggestion(null);
			return;
		}
		this.paused = false;
		this.callScheduler((scheduler) => scheduler.refresh());
	}

	private readSettings(): PredictiveSettings {
		try {
			return this.options.getSettings();
		} catch {
			return DEFAULT_SETTINGS;
		}
	}

	/**
	 * Completion was disabled: drop the ghost and cancel any debounced request. `updateCursor`
	 * is used because it cancels the scheduler timer without ever scheduling a new request.
	 */
	private pauseScheduler(snapshot: EditorSnapshot): void {
		if (this.suggestion !== null) this.clearSuggestion(null);
		if (this.paused) return;
		this.paused = true;
		this.callScheduler((scheduler) => scheduler.updateCursor(snapshot));
	}

	acceptAll(): boolean {
		return this.accept('all');
	}

	acceptWord(): boolean {
		return this.accept('word');
	}

	acceptSentence(): boolean {
		return this.accept('sentence');
	}

	acceptLine(): boolean {
		return this.accept('line');
	}

	dismiss(): boolean {
		const current = this.suggestion;
		if (this.destroyed || current === null) return false;
		if (this.composing || this.view.composing) return false;
		this.clearSuggestion({ type: 'reject', shownForMs: Date.now() - this.shownAt });
		this.callScheduler((scheduler) => scheduler.notifyRejected());
		return true;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.clearIgnoreTimer();
		this.suggestion = null;
		this.callScheduler((scheduler) => scheduler.dispose());
		this.scheduler = null;
		this.render(null);
	}

	private accept(granularity: AcceptGranularity | 'all'): boolean {
		const current = this.suggestion;
		if (this.destroyed || current === null) return false;
		if (this.composing || this.view.composing) return false;
		let result: AcceptResult;
		this.suppressValidation = true;
		try {
			result = applyAccept(this.view, current, granularity);
		} catch {
			return false;
		} finally {
			this.suppressValidation = false;
		}
		if (result.accepted.length === 0) return false;
		this.clearIgnoreTimer();
		const full = result.remaining === null;
		this.callScheduler((scheduler) => scheduler.notifyAccepted(result.accepted, full));
		const latest = this.latestSnapshot;
		if (latest !== null) this.callScheduler((scheduler) => scheduler.updateCursor(latest));
		this.reportFeedback(
			full
				? {
						type: 'accept-full',
						text: result.accepted,
						latencyMs: Math.max(0, Date.now() - current.candidate.createdAt),
						source: current.candidate.source,
					}
				: { type: 'accept-partial', text: result.accepted, source: current.candidate.source },
		);
		if (result.remaining === null) {
			this.suggestion = null;
			this.render(null);
			return true;
		}
		const updated: ActiveSuggestion = {
			...current,
			remainingText: result.remaining,
			anchor: current.anchor + result.accepted.length,
			docVersion: this.latestSnapshot?.docVersion ?? current.docVersion,
		};
		this.suggestion = updated;
		this.shownAt = Date.now();
		this.render(updated);
		this.armIgnoreTimer();
		return true;
	}

	private validateSnapshot(snapshot: EditorSnapshot, selectionOnly: boolean): void {
		const current = this.suggestion;
		if (current === null) return;
		if (snapshot.isComposing) return;
		if (!selectionOnly && snapshot.docVersion !== current.docVersion) {
			if (this.tryPrefixReuse(snapshot, current)) return;
			this.clearSuggestion({ type: 'ignored', shownForMs: Date.now() - this.shownAt });
			return;
		}
		if (snapshot.cursor !== current.anchor) this.clearSuggestion(null);
	}

	/**
	 * Incremental reuse: typing exactly the next characters of the suggestion keeps the ghost
	 * alive with the typed part removed, without asking the model again.
	 */
	private tryPrefixReuse(snapshot: EditorSnapshot, current: ActiveSuggestion): boolean {
		const edit = snapshot.lastEdit;
		if (edit === null) return false;
		if (edit.from !== edit.to) return false;
		if (edit.from !== current.anchor) return false;
		const inserted = edit.insertedText;
		if (inserted.length === 0 || inserted.length > current.remainingText.length) return false;
		if (!current.remainingText.startsWith(inserted)) return false;
		const typedEnd = inserted.length;
		if (
			typedEnd < current.remainingText.length &&
			isLowSurrogate(current.remainingText.charCodeAt(typedEnd))
		) {
			return false;
		}
		const remainingText = current.remainingText.slice(typedEnd);
		if (remainingText.length === 0) return false;
		const anchor = current.anchor + inserted.length;
		if (snapshot.cursor !== anchor) return false;
		const updated: ActiveSuggestion = {
			...current,
			remainingText,
			anchor,
			docVersion: snapshot.docVersion,
		};
		this.suggestion = updated;
		this.shownAt = Date.now();
		this.render(updated);
		this.armIgnoreTimer();
		return true;
	}

	private clearSuggestion(feedback: SuggestionFeedback | null): void {
		this.clearIgnoreTimer();
		this.suggestion = null;
		this.render(null);
		if (feedback !== null) this.reportFeedback(feedback);
	}

	private render(suggestion: ActiveSuggestion | null): void {
		const generation = ++this.renderGeneration;
		if (trySetGhostSuggestion(this.view, suggestion)) return;
		// The controller observes snapshots from inside the CM6 update that produced them, and
		// dispatching there is illegal. Defer exactly one retry, superseded by newer renders.
		this.queuedRender = { value: suggestion, generation };
		if (this.renderQueued) return;
		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			const queued = this.queuedRender;
			this.queuedRender = null;
			if (queued === null || this.destroyed) return;
			if (queued.generation !== this.renderGeneration) return;
			trySetGhostSuggestion(this.view, queued.value);
		});
	}

	private callScheduler(action: (scheduler: SchedulerPort) => void): void {
		const scheduler = this.scheduler;
		if (scheduler === null) return;
		try {
			action(scheduler);
		} catch {
			// Scheduler failures must never surface as editor exceptions.
		}
	}

	private reportFeedback(event: SuggestionFeedback): void {
		try {
			this.options.onFeedback?.(event);
		} catch {
			// Feedback sinks are optional and must not break editing.
		}
	}

	private armIgnoreTimer(): void {
		this.clearIgnoreTimer();
		const owner = this.view.dom.ownerDocument.defaultView ?? window;
		this.cancelIgnoreTimer = createWindowTimers(owner).schedule(() => {
			this.cancelIgnoreTimer = null;
			if (this.destroyed || this.suggestion === null) return;
			this.clearSuggestion({ type: 'ignored', shownForMs: Date.now() - this.shownAt });
		}, IGNORED_AFTER_MS);
	}

	private clearIgnoreTimer(): void {
		this.cancelIgnoreTimer?.();
		this.cancelIgnoreTimer = null;
	}
}
