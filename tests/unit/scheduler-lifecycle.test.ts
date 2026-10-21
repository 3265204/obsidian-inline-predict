import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionScheduler, REJECT_COOLDOWN_MS } from '../../src/scheduler/scheduler';
import type { SchedulerConfig } from '../../src/scheduler/scheduler';
import { LruPredictionCache, candidateCacheKey } from '../../src/scheduler/prediction-cache';
import { Telemetry } from '../../src/telemetry/stats';
import { createTokenBudget } from '../../src/tokens/budget';
import { ModelError } from '../../src/core/types';
import type {
	ActiveSuggestion,
	BuiltContext,
	CompletionCandidate,
	ContextBuilder,
	ContextSectionId,
	EditorSnapshot,
	PredictOptions,
	PredictionOutcome,
	PredictionRunner,
	SchedulerEvents,
	SchedulerStatus,
	SnapshotTrigger,
	TokenUsage,
} from '../../src/core/types';

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function emptyUsageRecord(): Record<ContextSectionId, number> {
	return {
		rules: 0,
		before: 0,
		after: 0,
		structure: 0,
		knowledge: 0,
		profile: 0,
		'recent-edits': 0,
	};
}

class FakeContextBuilder implements ContextBuilder {
	buildCalls = 0;
	invalidations: (string | undefined)[] = [];

	async build(snapshot: EditorSnapshot, signal: AbortSignal): Promise<BuiltContext> {
		this.buildCalls++;
		if (signal.aborted) throw new ModelError('aborted', 'aborted');
		const budget = createTokenBudget({ contextWindow: 4096, reservedOutputTokens: 256 });
		return {
			snapshot,
			sections: [],
			report: { budget, usedBySection: emptyUsageRecord(), omitted: [], totalInputTokens: 0 },
			createdAt: Date.now(),
			warmKey: null,
		};
	}

	invalidate(docId?: string): void {
		this.invalidations.push(docId);
	}
}

type Responder = (context: BuiltContext, options: PredictOptions) => Promise<PredictionOutcome>;

class FakeRunner implements PredictionRunner {
	readonly modelId = 'fake-model';
	readonly contextWindow = 4096;
	calls: { context: BuiltContext; options: PredictOptions }[] = [];
	responder: Responder = async (context) => ({
		candidate: makeCandidate(context.snapshot, 'hello world'),
		reason: null,
		usage: null,
		finishReason: 'stop',
	});

	predict(context: BuiltContext, options: PredictOptions): Promise<PredictionOutcome> {
		this.calls.push({ context, options });
		return this.responder(context, options);
	}
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSnapshot(
	options: {
		prefix?: string;
		docVersion?: number;
		docId?: string;
		trigger?: SnapshotTrigger;
		isComposing?: boolean;
		lastEditAt?: number;
		cursor?: number;
	} = {},
): EditorSnapshot {
	const prefix = options.prefix ?? 'Hello ';
	const prefixOffset = 0;
	const cursor = options.cursor ?? prefix.length;
	const lastNewline = prefix.lastIndexOf('\n');
	return {
		docId: options.docId ?? 'notes/test.md',
		docVersion: options.docVersion ?? 1,
		cursor,
		selectionFrom: cursor,
		selectionTo: cursor,
		prefix,
		prefixOffset,
		suffix: '',
		line: 0,
		ch: cursor,
		lineTextBefore: lastNewline === -1 ? prefix : prefix.slice(lastNewline + 1),
		lineTextAfter: '',
		isComposing: options.isComposing ?? false,
		timestamp: options.lastEditAt ?? 0,
		trigger: options.trigger ?? 'doc-change',
		lastEdit:
			options.lastEditAt === undefined
				? null
				: {
						from: cursor,
						to: cursor,
						insertedText: '',
						removedLength: 0,
						at: options.lastEditAt,
					},
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

function makeCandidate(
	snapshot: EditorSnapshot,
	text = 'hello world',
	overrides: Partial<CompletionCandidate> = {},
): CompletionCandidate {
	return {
		requestId: 1,
		text,
		docId: snapshot.docId,
		docVersion: snapshot.docVersion,
		anchor: snapshot.cursor,
		finishReason: 'stop',
		usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, estimated: false },
		modelId: 'fake-model',
		createdAt: 0,
		latencyMs: 12,
		source: 'model',
		degraded: false,
		reuseContext: { prefix: snapshot.prefix, prefixOffset: snapshot.prefixOffset, suffix: snapshot.suffix },
		...overrides,
	};
}

function outcome(
	candidate: CompletionCandidate | null,
	usage: TokenUsage | null = candidate?.usage ?? null,
): PredictionOutcome {
	return { candidate, reason: candidate === null ? 'no-intent' : null, usage, finishReason: 'stop' };
}

function createHarness(
	overrides: { config?: Partial<SchedulerConfig>; cache?: LruPredictionCache } = {},
): {
	contextBuilder: FakeContextBuilder;
	runner: FakeRunner;
	cache: LruPredictionCache;
	telemetry: Telemetry;
	config: SchedulerConfig;
	statuses: SchedulerStatus[];
	suggestions: (ActiveSuggestion | null)[];
	events: SchedulerEvents;
	scheduler: CompletionScheduler;
} {
	const contextBuilder = new FakeContextBuilder();
	const runner = new FakeRunner();
	const cache =
		overrides.cache ?? new LruPredictionCache({ ttlMs: 60_000, maxEntries: 8 });
	const telemetry = new Telemetry({ now: () => Date.now() });
	const config: SchedulerConfig = {
		baseDebounceMs: 400,
		minRequestIntervalMs: 350,
		maxOutputTokens: 256,
		requestTimeoutMs: 5000,
		temperature: 0.2,
		cacheEntries: 8,
		contextCacheEntries: 4,
		debug: false,
		...overrides.config,
	};
	const statuses: SchedulerStatus[] = [];
	const suggestions: (ActiveSuggestion | null)[] = [];
	const events: SchedulerEvents = {
		onSuggestion: (suggestion) => suggestions.push(suggestion),
		onStatus: (status) => statuses.push(status),
	};
	const scheduler = new CompletionScheduler({
		contextBuilder,
		runner,
		cache,
		telemetry,
		getConfig: () => config,
		events,
	});
	return { contextBuilder, runner, cache, telemetry, config, statuses, suggestions, events, scheduler };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await flushMicrotasks();
}

/** Show a candidate through a real (fake-timer) request; returns the active suggestion. */
async function showCandidate(
	harness: ReturnType<typeof createHarness>,
	text = 'hello world',
	prefix = 'Hi ',
): Promise<ActiveSuggestion> {
	harness.runner.responder = async (context) => outcome(makeCandidate(context.snapshot, text));
	harness.scheduler.update(makeSnapshot({ prefix }));
	await advance(400);
	const active = harness.scheduler.current();
	if (active === null) throw new Error('expected a suggestion to be shown');
	return active;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Debounce & trigger behaviour                                        */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler debounce', () => {
	it('turns a typing burst into exactly one request', async () => {
		const harness = createHarness();
		for (let i = 1; i <= 5; i++) {
			await advance(80);
			harness.scheduler.update(
				makeSnapshot({
					prefix: `Hello world${'x'.repeat(i)}`,
					docVersion: i,
					lastEditAt: Date.now(),
				}),
			);
			expect(harness.runner.calls).toHaveLength(0);
		}
		expect(harness.statuses).toContain('waiting');
		await advance(2000);
		expect(harness.runner.calls).toHaveLength(1);
		expect(harness.scheduler.current()?.remainingText).toBe('hello world');
	});

	it('requests earlier at a semantic boundary than mid-word', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Done. ' }));
		await advance(159);
		expect(harness.runner.calls).toHaveLength(0);
		await advance(2);
		expect(harness.runner.calls).toHaveLength(1);
	});

	it('enforces the minimum interval between requests', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Done. ' }));
		await advance(160);
		expect(harness.runner.calls).toHaveLength(1);

		// 50 ms later a new boundary wants to fire at 160 ms, but min interval needs 300 ms.
		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hello! ', docVersion: 2, lastEditAt: Date.now() }));
		await advance(299);
		expect(harness.runner.calls).toHaveLength(1);
		await advance(2);
		expect(harness.runner.calls).toHaveLength(2);
	});

	it('emits meaningful status transitions', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		await advance(400);
		expect(harness.statuses).toEqual(['waiting', 'requesting', 'idle']);
	});
});

/* ------------------------------------------------------------------ */
/* Composition & lifecycle guards                                      */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler composition', () => {
	it('never calls the model while composing and clears timers', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Hello ', isComposing: true }));
		expect(harness.scheduler.getStatus()).toBe('waiting');
		await advance(10_000);
		expect(harness.runner.calls).toHaveLength(0);
		expect(harness.contextBuilder.buildCalls).toBe(0);

		// End of composition: a normal snapshot schedules a request again.
		harness.scheduler.update(
			makeSnapshot({ prefix: 'Hello ', trigger: 'composition-end', lastEditAt: Date.now() }),
		);
		await advance(500);
		expect(harness.runner.calls).toHaveLength(1);
	});
});

describe('CompletionScheduler request guards', () => {
	it('aborts the previous request when a newer one starts', async () => {
		const harness = createHarness();
		const first = deferred<PredictionOutcome>();
		const second = deferred<PredictionOutcome>();
		harness.runner.responder = () => (harness.runner.calls.length === 1 ? first.promise : second.promise);

		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		await advance(400);
		expect(harness.runner.calls).toHaveLength(1);
		const firstSignal = harness.runner.calls[0]?.options.signal;
		expect(firstSignal?.aborted).toBe(false);

		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi x', docVersion: 2, lastEditAt: Date.now() }));
		await advance(1500);
		expect(harness.runner.calls).toHaveLength(2);
		expect(firstSignal?.aborted).toBe(true);

		// The aborted request's late result must never be applied.
		first.resolve(outcome(makeCandidate(makeSnapshot({ prefix: 'Hi ' }), 'stale result')));
		await flushMicrotasks();
		expect(harness.scheduler.current()).toBeNull();

		const secondSnapshot = harness.runner.calls[1]?.context.snapshot;
		if (secondSnapshot === undefined) throw new Error('missing second request context');
		second.resolve(outcome(makeCandidate(secondSnapshot, 'fresh result')));
		await flushMicrotasks();
		expect(harness.scheduler.current()?.remainingText).toBe('fresh result');
	});

	it('drops a late result once the document version moved on', async () => {
		const harness = createHarness();
		const pending = deferred<PredictionOutcome>();
		harness.runner.responder = () => pending.promise;

		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		await advance(400);
		expect(harness.runner.calls).toHaveLength(1);

		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi x', docVersion: 2, lastEditAt: Date.now() }));
		pending.resolve(outcome(makeCandidate(makeSnapshot({ prefix: 'Hi ', docVersion: 1 }), 'stale')));
		await flushMicrotasks();

		expect(harness.scheduler.current()).toBeNull();
		expect(harness.scheduler.getStaleDrops()).toBe(1);
		expect(harness.telemetry.snapshot().requests).toBe(1);
		expect(harness.suggestions.filter((s) => s !== null)).toHaveLength(0);
	});

	it('accepts a candidate when the cursor stayed at the anchor', async () => {
		const harness = createHarness();
		const active = await showCandidate(harness);
		expect(active.candidate.docId).toBe('notes/test.md');
		expect(active.anchor).toBe(3);
	});
});

/* ------------------------------------------------------------------ */
/* Prefix reuse & cache                                                */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler prefix reuse', () => {
	it('shows the remainder without calling the model again', async () => {
		const harness = createHarness();
		await showCandidate(harness);

		await advance(30);
		harness.scheduler.update(
			makeSnapshot({ prefix: 'Hi hello ', docVersion: 2, lastEditAt: Date.now() }),
		);
		const active = harness.scheduler.current();
		expect(active?.remainingText).toBe('world');
		expect(active?.anchor).toBe(9);
		expect(harness.runner.calls).toHaveLength(1);
		expect(harness.telemetry.snapshot().prefixReuses).toBe(1);
		expect(harness.scheduler.getStatus()).toBe('cached');
	});

	it('clears the suggestion on a mismatch and schedules a new prediction', async () => {
		const harness = createHarness();
		await showCandidate(harness);
		await advance(30);
		harness.scheduler.update(
			makeSnapshot({ prefix: 'Hi goodbye', docVersion: 2, lastEditAt: Date.now() }),
		);
		expect(harness.scheduler.current()).toBeNull();
		expect(harness.scheduler.getStatus()).toBe('waiting');
		await advance(2000);
		expect(harness.runner.calls).toHaveLength(2);
	});

	it('shows the cached candidate with no runner call', async () => {
		const harness = createHarness();
		const snapshot = makeSnapshot({ prefix: 'Hi ' });
		const cached = makeCandidate(snapshot, 'there');
		harness.cache.set(candidateCacheKey(cached), cached);

		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		const active = harness.scheduler.current();
		expect(active?.remainingText).toBe('there');
		expect(active?.reusedFromRequestId).toBe(cached.requestId);
		expect(harness.runner.calls).toHaveLength(0);
		expect(harness.telemetry.snapshot().cacheHits).toBe(1);
		expect(harness.cache.size).toBe(0);
		expect(harness.scheduler.getStatus()).toBe('cached');
	});

	it('expired cache entries are not reused', async () => {
		const harness = createHarness();
		const snapshot = makeSnapshot({ prefix: 'Hi ' });
		const cached = makeCandidate(snapshot, 'there');
		harness.cache.set(candidateCacheKey(cached), cached);
		await advance(61_000);
		expect(harness.cache.size).toBe(0);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ', docVersion: 2, lastEditAt: Date.now() }));
		expect(harness.runner.calls).toHaveLength(0);
		await advance(1000);
		expect(harness.runner.calls).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ */
/* Failures & backoff                                                  */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler backoff', () => {
	it('backs off after failures and resets after a success', async () => {
		const harness = createHarness();
		harness.runner.responder = async () => {
			throw new ModelError('network', 'boom', { retryable: true });
		};
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		await advance(400);
		expect(harness.telemetry.snapshot().requestFailures).toBe(1);
		expect(harness.scheduler.getStatus()).toBe('backoff');

		// No retry per keystroke: the backoff timer must elapse before the next attempt.
		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi x', docVersion: 2, lastEditAt: Date.now() }));
		await advance(1400);
		expect(harness.runner.calls).toHaveLength(1);
		harness.runner.responder = async (context) => outcome(makeCandidate(context.snapshot, 'recovered'));
		await advance(200);
		expect(harness.runner.calls).toHaveLength(2);
		expect(harness.scheduler.current()?.remainingText).toBe('recovered');

		// A success resets the failure counter: the next request is debounced normally, not backed off.
		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi xy', docVersion: 3, lastEditAt: Date.now() }));
		await advance(500);
		expect(harness.runner.calls).toHaveLength(3);
	});

	it('does not report aborts as failures', async () => {
		const harness = createHarness();
		const pending = deferred<PredictionOutcome>();
		harness.runner.responder = () => pending.promise;
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		await advance(400);
		await advance(50);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi x', docVersion: 2, lastEditAt: Date.now() }));
		await advance(1500);
		pending.reject(new ModelError('aborted', 'superseded'));
		await flushMicrotasks();
		expect(harness.telemetry.snapshot().requestFailures).toBe(0);
	});
});

/* ------------------------------------------------------------------ */
/* Explicit requests & feedback                                        */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler requestNow', () => {
	it('bypasses the debounce and cancels the pending timer', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		harness.scheduler.requestNow();
		await flushMicrotasks();
		expect(harness.runner.calls).toHaveLength(1);
		await advance(1000);
		expect(harness.runner.calls).toHaveLength(1);
	});

	it('respects composition', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ', isComposing: true }));
		harness.scheduler.requestNow();
		await flushMicrotasks();
		expect(harness.runner.calls).toHaveLength(0);
		expect(harness.scheduler.getStatus()).toBe('waiting');
	});

	it('respects failure backoff', async () => {
		const harness = createHarness();
		harness.runner.responder = async () => {
			throw new ModelError('server', 'down', { retryable: true });
		};
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ' }));
		harness.scheduler.requestNow();
		await flushMicrotasks();
		expect(harness.runner.calls).toHaveLength(1);
		harness.scheduler.requestNow();
		await flushMicrotasks();
		expect(harness.runner.calls).toHaveLength(1);
		await advance(1400);
		expect(harness.runner.calls).toHaveLength(1);
		await advance(200);
		expect(harness.runner.calls).toHaveLength(2);
	});
});

describe('CompletionScheduler feedback', () => {
	it('trims the remainder on partial accept and clears on full accept', async () => {
		const harness = createHarness();
		await showCandidate(harness);

		harness.scheduler.notifyAccepted('hello ', false);
		expect(harness.scheduler.current()?.remainingText).toBe('world');
		expect(harness.scheduler.current()?.anchor).toBe(9);
		expect(harness.telemetry.snapshot().partialAccepts).toBe(1);
		expect(harness.cache.size).toBe(0);

		harness.scheduler.notifyAccepted('world', true);
		expect(harness.scheduler.current()).toBeNull();
		expect(harness.telemetry.snapshot().fullAccepts).toBe(1);
	});

	it('clears on reject and cools down the same anchor', async () => {
		const harness = createHarness();
		await showCandidate(harness);
		harness.scheduler.notifyRejected();
		expect(harness.scheduler.current()).toBeNull();
		expect(harness.telemetry.snapshot().rejects).toBe(1);
		expect(harness.cache.size).toBe(0);

		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ', docVersion: 2 }));
		expect(harness.scheduler.getStatus()).toBe('waiting');
		await advance(REJECT_COOLDOWN_MS - 100);
		expect(harness.runner.calls).toHaveLength(1);

		// Past the cooldown window a fresh update may schedule again.
		await advance(200);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hi ', docVersion: 3, lastEditAt: Date.now() }));
		await advance(600);
		expect(harness.runner.calls).toHaveLength(2);
	});

	it('updateCursor reuses a still-valid suggestion and clears a moved anchor', async () => {
		const harness = createHarness();
		await showCandidate(harness);

		harness.scheduler.updateCursor(makeSnapshot({ prefix: 'Hi ', cursor: 3, docVersion: 2 }));
		expect(harness.scheduler.current()?.remainingText).toBe('hello world');
		expect(harness.scheduler.getStatus()).toBe('cached');

		harness.scheduler.updateCursor(makeSnapshot({ prefix: 'Hi ', cursor: 1, docVersion: 3 }));
		expect(harness.scheduler.current()).toBeNull();
		expect(harness.scheduler.getStatus()).toBe('idle');
		expect(harness.runner.calls).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

describe('CompletionScheduler lifecycle', () => {
	it('dispose clears timers and stops emitting', async () => {
		const harness = createHarness();
		harness.scheduler.update(makeSnapshot({ prefix: 'Hello ' }));
		harness.scheduler.dispose();
		expect(harness.scheduler.getStatus()).toBe('disabled');
		expect(harness.suggestions.at(-1)).toBeNull();
		const emittedAtDispose = harness.suggestions.length;

		await advance(5000);
		expect(harness.runner.calls).toHaveLength(0);
		harness.scheduler.update(makeSnapshot({ prefix: 'Hello x', docVersion: 2 }));
		harness.scheduler.requestNow();
		await advance(5000);
		expect(harness.runner.calls).toHaveLength(0);
		expect(harness.suggestions).toHaveLength(emittedAtDispose);
	});

	it('refresh resizes the cache to the current config', () => {
		const harness = createHarness({ config: { cacheEntries: 4 } });
		const snapshot = makeSnapshot({ prefix: 'Hi ' });
		for (let i = 0; i < 4; i++) {
			const cached = makeCandidate(snapshot, `candidate ${i}`, { anchor: i });
			harness.cache.set(candidateCacheKey(cached), cached);
		}
		expect(harness.cache.size).toBe(4);
		harness.config.cacheEntries = 2;
		harness.scheduler.refresh();
		expect(harness.cache.size).toBe(2);
		expect(harness.cache.stats().maxEntries).toBe(2);
	});
});
