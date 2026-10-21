/**
 * Completion scheduler: the only place that decides *when* to call the model, and the only place
 * that guards against stale responses reaching the editor.
 *
 * The scheduler is deliberately "always willing to predict" — whether auto-trigger is enabled,
 * whether a model is configured and whether the cursor is in a sensible place are decisions of the
 * completion controller / settings layer. Keeping the scheduler unconditional makes it testable
 * and keeps `main.ts` thin. The only gating it performs itself is local and structural: IME
 * composition (never predict), one in-flight request, backoff after failures, and the rejection
 * cooldown for the same anchor.
 *
 * Ordering per update is intentional: reuse what is on screen (free), then reuse the cache (free),
 * then schedule a debounced request (costs money). The request execution loop itself lives in
 * `request-executor.ts`.
 */

import type {
	ActiveSuggestion,
	CompletionCandidate,
	ContextBuilder,
	EditorSnapshot,
	PredictionRunner,
	SchedulerEvents,
	SchedulerPort,
	SchedulerStatus,
} from '../core/types';
import { EDIT_HISTORY_SIZE } from '../core/constants';
import { commonPrefixLength } from '../core/text';
import { candidateCacheKey } from './prediction-cache';
import type { LruPredictionCache } from './prediction-cache';
import { RequestExecutor } from './request-executor';
import type { RequestObserver, RequestResult } from './request-executor';
import { findReusableActive, findReusableCached } from './reuse';
import { decideTrigger } from './trigger-policy';
import type { Telemetry } from '../telemetry/stats';

/** Settings snapshot the scheduler needs. Read through `deps.getConfig()` on every use. */
export interface SchedulerConfig {
	baseDebounceMs: number;
	minRequestIntervalMs: number;
	maxOutputTokens: number;
	requestTimeoutMs: number;
	temperature: number;
	cacheEntries: number;
	contextCacheEntries: number;
	debug: boolean;
	/**
	 * Master switch. When false the scheduler cancels pending work and clears suggestions.
	 * Optional for backwards compatibility; undefined means enabled.
	 */
	enabled?: boolean;
	/** When false, only explicit `requestNow()` produces new suggestions. */
	autoTrigger?: boolean;
	/** Minimum captured prefix length before an automatic request is considered. */
	minPrefixChars?: number;
	/** 模型或提示配置变化时，使旧请求与旧候选失效。 */
	configurationVersion?: number;
}

export interface SchedulerDeps {
	contextBuilder: ContextBuilder;
	runner: PredictionRunner;
	cache: LruPredictionCache;
	telemetry: Telemetry;
	getConfig(): SchedulerConfig;
	events: SchedulerEvents;
	/** Injectable clock (defaults to `Date.now`) so tests can drive fake timers. */
	now?: () => number;
}

/** After a rejection, do not re-ask for the same anchor for this long. */
export const REJECT_COOLDOWN_MS = 2000;

/** Length of `acceptedText` that is actually a prefix of the remaining suggestion. */
function acceptedPrefixLength(remainingText: string, acceptedText: string): number {
	if (acceptedText.length === 0) return 0;
	if (remainingText.startsWith(acceptedText)) return acceptedText.length;
	return Math.min(remainingText.length, commonPrefixLength(remainingText, acceptedText));
}

export class CompletionScheduler implements SchedulerPort {
	private readonly deps: SchedulerDeps;
	private readonly now: () => number;
	private readonly executor: RequestExecutor;
	private readonly requestObserver: RequestObserver;
	private events: SchedulerEvents;
	private status: SchedulerStatus = 'idle';
	private snapshot: EditorSnapshot | null = null;
	private active: ActiveSuggestion | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private failureCount = 0;
	private editTimestamps: number[] = [];
	private editHistoryDocId: string | null = null;
	private rejectedAnchor: number | null = null;
	private rejectedDocId: string | null = null;
	private rejectCooldownUntil = 0;
	private disposed = false;
	private configurationVersion: number;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.events = deps.events;
		this.configurationVersion = deps.getConfig().configurationVersion ?? 0;
		this.executor = new RequestExecutor({
			contextBuilder: deps.contextBuilder,
			runner: deps.runner,
			getConfig: () => this.deps.getConfig(),
			getSnapshot: () => this.snapshot,
			now: this.now,
		});
		this.requestObserver = {
			onSettled: (result) => {
				this.deps.telemetry.recordRequest({ ...result });
				if (result.reason === 'error' || result.reason === 'timeout' || result.reason === 'rate-limited') {
					this.deps.telemetry.recordFailure({ latencyMs: result.latencyMs });
				}
			},
			onStarted: () => this.setStatus('requesting'),
			onResult: (result) => this.handleResult(result),
			onFailure: () => this.handleFailure(),
			onStale: () => {
				this.setStatus(this.active === null ? 'idle' : 'cached');
			},
		};
		this.applyCacheConfig();
	}

	/* ------------------------------------------------------------------ */
	/* SchedulerPort                                                       */
	/* ------------------------------------------------------------------ */

	/** Called for every relevant editor event; debounces, reuses or ignores it. */
	update(snapshot: EditorSnapshot): void {
		if (this.disposed) return;
		const config = this.deps.getConfig();
		if (config.enabled === false) {
			this.snapshot = snapshot;
			this.cancelTimer();
			this.executor.abort();
			this.clearActive();
			this.setStatus('disabled');
			return;
		}
		if (snapshot.trigger === 'selection') {
			this.updateCursor(snapshot);
			return;
		}
		this.snapshot = snapshot;
		this.recordEdit(snapshot);

		// IME composition: cancel everything and stay quiet. No model call can be useful while the
		// user is still composing characters.
		if (snapshot.isComposing) {
			this.cancelTimer();
			this.executor.abort();
			this.clearActive();
			this.setStatus('waiting');
			return;
		}

		// 1. The suggestion already on screen may still be valid; showing its remainder is free.
		if (this.active !== null) {
			const reused = findReusableActive(this.active, snapshot);
			if (reused !== null) {
				this.active = {
					...this.active,
					remainingText: reused.remaining,
					anchor: reused.anchor,
					docVersion: snapshot.docVersion,
				};
				this.cancelTimer();
				this.deps.telemetry.recordCandidateShown('prefix-reuse');
				this.setStatus('cached');
				this.emitSuggestion();
				return;
			}
			// Typed text diverged: the ghost is wrong now.
			this.clearActive();
		}

		// 2. Respect the post-rejection cooldown before trying anything else at this anchor.
		if (this.isRejectCooldownActive(snapshot)) {
			this.cancelTimer();
			this.setStatus('waiting');
			return;
		}

		// 3. A previously cached candidate may match what was typed since its own anchor.
		const cached = findReusableCached(this.deps.cache.entriesInRecencyOrder(), snapshot);
		if (cached !== null) {
			this.deps.cache.consume(candidateCacheKey(cached.candidate));
			this.active = {
				candidate: { ...cached.candidate, docVersion: snapshot.docVersion, source: 'cache' },
				remainingText: cached.remaining,
				anchor: cached.anchor,
				docVersion: snapshot.docVersion,
				reusedFromRequestId: cached.candidate.requestId,
			};
			this.cancelTimer();
			this.deps.telemetry.recordCandidateShown('cache', this.candidateIdentity(cached.candidate));
			this.setStatus('cached');
			this.emitSuggestion();
			return;
		}

		// 4. Automatic triggering may be disabled entirely, or the document may be too empty to
		//    justify spending a request on it. Manual `requestNow()` bypasses both gates.
		if (config.autoTrigger === false) {
			this.cancelTimer();
			this.setStatus('waiting');
			return;
		}
		if (snapshot.prefix.length < (config.minPrefixChars ?? 0)) {
			this.cancelTimer();
			this.setStatus('waiting');
			return;
		}

		// 5. Nothing free applies: run the trigger policy and schedule a request.
		this.scheduleFromPolicy(snapshot, false);
	}

	/** Cursor/selection movement without a document change: validate or clear the ghost. */
	updateCursor(snapshot: EditorSnapshot): void {
		if (this.disposed) return;
		if (this.deps.getConfig().enabled === false) {
			this.snapshot = snapshot;
			this.cancelTimer();
			this.executor.abort();
			this.clearActive();
			this.setStatus('disabled');
			return;
		}
		this.snapshot = snapshot;
		this.cancelTimer();
		if (snapshot.isComposing) {
			this.clearActive();
			this.setStatus('waiting');
			return;
		}
		if (this.active !== null) {
			const reused = findReusableActive(this.active, snapshot);
			if (reused !== null) {
				this.active = {
					...this.active,
					remainingText: reused.remaining,
					anchor: reused.anchor,
					docVersion: snapshot.docVersion,
				};
				this.setStatus('cached');
				this.emitSuggestion();
				return;
			}
			this.clearActive();
		}
		this.setStatus('idle');
	}

	notifyAccepted(acceptedText: string, full: boolean): void {
		if (this.disposed) return;
		const active = this.active;
		this.deps.telemetry.recordAccept(full, active === null ? undefined : this.candidateIdentity(active.candidate));
		if (active !== null) this.deps.cache.consume(candidateCacheKey(active.candidate));
		this.cancelTimer();
		this.clearRejectCooldown();
		if (active === null || full) {
			this.clearActive();
			this.setStatus('idle');
			return;
		}
		const acceptedLength = acceptedPrefixLength(active.remainingText, acceptedText);
		const remainingText = active.remainingText.slice(acceptedLength);
		if (remainingText.length === 0) {
			this.clearActive();
			this.setStatus('idle');
			return;
		}
		this.active = { ...active, remainingText, anchor: active.anchor + acceptedLength };
		this.setStatus('idle');
		this.emitSuggestion();
	}

	notifyRejected(): void {
		if (this.disposed) return;
		this.deps.telemetry.recordReject();
		this.cancelTimer();
		const active = this.active;
		if (active !== null) {
			this.deps.cache.consume(candidateCacheKey(active.candidate));
			this.rejectedAnchor = active.anchor;
			this.rejectedDocId = active.candidate.docId;
			this.rejectCooldownUntil = this.now() + REJECT_COOLDOWN_MS;
		}
		this.clearActive();
		this.setStatus('idle');
	}

	current(): ActiveSuggestion | null {
		return this.active;
	}

	/** Explicit user command: bypass the debounce, still respect composition and failure backoff. */
	requestNow(): void {
		if (this.disposed) return;
		if (this.deps.getConfig().enabled === false) return;
		const snapshot = this.snapshot;
		if (snapshot === null) return;
		if (snapshot.isComposing) {
			this.cancelTimer();
			this.setStatus('waiting');
			return;
		}
		if (this.failureCount > 0) {
			// Let the backoff win: requestNow must not be used to hammer a failing provider.
			this.scheduleFromPolicy(snapshot, false);
			return;
		}
		this.clearRejectCooldown();
		this.cancelTimer();
		this.executor.start(this.requestObserver);
	}

	refresh(): void {
		if (this.disposed) return;
		this.applyCacheConfig();
		const config = this.deps.getConfig();
		const version = config.configurationVersion ?? 0;
		if (version !== this.configurationVersion || config.enabled === false) {
			this.configurationVersion = version;
			this.cancelTimer();
			this.executor.abort();
			this.clearActive();
			this.failureCount = 0;
			this.setStatus(config.enabled === false ? 'disabled' : 'idle');
			return;
		}
		if (config.autoTrigger === false) { this.cancelTimer(); return; }
		const snapshot = this.snapshot;
		if (snapshot !== null && this.timer !== null) {
			this.cancelTimer();
			this.scheduleFromPolicy(snapshot, false);
		}
	}

	setEvents(events: SchedulerEvents): void {
		this.events = events;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelTimer();
		this.executor.dispose();
		this.active = null;
		this.events.onSuggestion(null);
		this.setStatus('disabled');
	}

	/* ------------------------------------------------------------------ */
	/* Diagnostics helpers (not part of SchedulerPort)                    */
	/* ------------------------------------------------------------------ */

	getStatus(): SchedulerStatus {
		return this.status;
	}

	/** Number of results dropped because the document/cursor moved on. */
	getStaleDrops(): number {
		return this.executor.staleDropped;
	}

	/* ------------------------------------------------------------------ */
	/* Request result handling                                             */
	/* ------------------------------------------------------------------ */

	private handleResult(result: RequestResult): void {
		const { candidate } = result;
		if (candidate === null && result.reason === 'off-topic') {
			this.deps.telemetry.recordOffTopic();
		}
		// A completed request (even one that yields no candidate) means the provider works.
		this.failureCount = 0;
		if (candidate === null || candidate.text.length === 0) {
			this.setStatus('idle');
			return;
		}
		const snapshot = this.snapshot;
		if (snapshot === null) return;
		const normalized = { ...candidate, docVersion: snapshot.docVersion };
		this.deps.cache.set(candidateCacheKey(normalized), normalized);
		this.active = {
			candidate: normalized,
			remainingText: normalized.text,
			anchor: normalized.anchor,
			docVersion: snapshot.docVersion,
			reusedFromRequestId: null,
		};
		this.deps.telemetry.recordCandidateShown('model', this.candidateIdentity(normalized));
		this.setStatus('idle');
		this.emitSuggestion();
	}

	private handleFailure(): void {
		this.failureCount++;
		this.setStatus('backoff');
	}

	/* ------------------------------------------------------------------ */
	/* Scheduling internals                                                */
	/* ------------------------------------------------------------------ */

	private applyCacheConfig(): void {
		this.deps.cache.setMaxEntries(this.deps.getConfig().cacheEntries);
	}

	private emitSuggestion(): void {
		this.events.onSuggestion(this.active);
	}

	private candidateIdentity(candidate: CompletionCandidate): string {
		return [candidate.docId, candidate.modelId, candidate.requestId, candidate.createdAt, candidate.anchor].join('\u0000');
	}

	private setStatus(next: SchedulerStatus): void {
		if (this.status === next) return;
		this.status = next;
		this.events.onStatus(next);
	}

	private cancelTimer(): void {
		if (this.timer === null) return;
		globalThis.clearTimeout(this.timer);
		this.timer = null;
	}

	private scheduleTimer(delayMs: number): void {
		this.cancelTimer();
		this.timer = globalThis.setTimeout(() => {
			this.timer = null;
			if (this.disposed) return;
			this.executor.start(this.requestObserver);
		}, Math.max(0, Math.round(delayMs)));
	}

	private clearActive(): void {
		if (this.active === null) return;
		this.active = null;
		this.emitSuggestion();
	}

	private recordEdit(snapshot: EditorSnapshot): void {
		// Typing-speed history is per document: intervals across a file switch are meaningless.
		if (snapshot.docId !== this.editHistoryDocId) {
			this.editTimestamps = [];
			this.editHistoryDocId = snapshot.docId;
		}
		const edit = snapshot.lastEdit;
		if (edit === null || !Number.isFinite(edit.at)) return;
		const last = this.editTimestamps[this.editTimestamps.length - 1];
		if (last === edit.at) return;
		this.editTimestamps.push(edit.at);
		if (this.editTimestamps.length > EDIT_HISTORY_SIZE) {
			this.editTimestamps.splice(0, this.editTimestamps.length - EDIT_HISTORY_SIZE);
		}
	}

	private interEditIntervals(): number[] {
		const intervals: number[] = [];
		for (let i = 1; i < this.editTimestamps.length; i++) {
			const previous = this.editTimestamps[i - 1];
			const current = this.editTimestamps[i];
			if (previous === undefined || current === undefined) continue;
			intervals.push(current - previous);
		}
		return intervals;
	}

	private isRejectCooldownActive(snapshot: EditorSnapshot): boolean {
		if (this.rejectedAnchor === null) return false;
		if (snapshot.docId !== this.rejectedDocId || snapshot.cursor !== this.rejectedAnchor) {
			this.clearRejectCooldown();
			return false;
		}
		return this.now() < this.rejectCooldownUntil;
	}

	private clearRejectCooldown(): void {
		this.rejectedAnchor = null;
		this.rejectedDocId = null;
		this.rejectCooldownUntil = 0;
	}

	private scheduleFromPolicy(snapshot: EditorSnapshot, force: boolean): void {
		const config = this.deps.getConfig();
		const latency = this.deps.telemetry.latencySummary();
		const decision = decideTrigger({
			snapshot,
			now: this.now(),
			baseDebounceMs: config.baseDebounceMs,
			minRequestIntervalMs: config.minRequestIntervalMs,
			lastRequestAt: this.executor.lastRequestAt,
			failedAttempts: this.failureCount,
			interEditIntervalsMs: this.interEditIntervals(),
			p50LatencyMs: latency.count > 0 ? latency.p50 : null,
			force,
		});
		if (decision.action === 'skip') {
			this.cancelTimer();
			this.setStatus('waiting');
			return;
		}
		if (decision.action === 'request') {
			this.cancelTimer();
			this.executor.start(this.requestObserver);
			return;
		}
		this.scheduleTimer(decision.delayMs);
		this.setStatus(decision.reason === 'backoff' ? 'backoff' : 'waiting');
	}
}
