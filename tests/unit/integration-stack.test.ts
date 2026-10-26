/**
 * End-to-end wiring test: real scheduler + real context engine + real prediction engine,
 * talking to a fake model adapter. This is the only place where the M2/M3 modules are exercised
 * together, so it guards the seams (prompt assembly, validation, caching, prefix reuse, gating).
 */

import { testTimers } from '../helpers/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ActiveSuggestion,
	ChatMessage,
	EditorSnapshot,
	FinishReason,
	ModelAdapter,
	ModelRequest,
	ModelResponse,
	SchedulerStatus,
	TokenUsage,
} from '../../src/core/types';
import { ContextEngine } from '../../src/context/context-engine';
import { PredictionEngine } from '../../src/prediction/engine';
import { LruPredictionCache } from '../../src/scheduler/prediction-cache';
import { CompletionScheduler } from '../../src/scheduler/scheduler';
import type { SchedulerConfig } from '../../src/scheduler/scheduler';
import { Telemetry } from '../../src/telemetry/stats';
import { heuristicTokenCounter } from '../../src/tokens/estimator';

const USAGE: TokenUsage = {
	inputTokens: 120,
	outputTokens: 8,
	totalTokens: 128,
	estimated: false,
};

class FakeAdapter implements ModelAdapter {
	readonly id = 'fake';
	readonly modelId = 'fake-model';
	readonly contextWindow = 8_192;
	readonly tokenCounter = heuristicTokenCounter;
	readonly calls: ModelRequest[] = [];

	constructor(private readonly reply: (callIndex: number) => ModelResponse) {}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.calls.push(request);
		return this.reply(this.calls.length - 1);
	}

	get messages(): ChatMessage[][] {
		return this.calls.map((call) => [...call.messages]);
	}
}

function modelResponse(text: string, finishReason: FinishReason = 'stop'): ModelResponse {
	return { text, finishReason, usage: USAGE, modelId: 'fake-model' };
}

function snapshot(
	prefix: string,
	options: {
		suffix?: string;
		docVersion?: number;
		cursor?: number;
		lastEdit?: EditorSnapshot['lastEdit'];
		trigger?: EditorSnapshot['trigger'];
		isComposing?: boolean;
		docId?: string;
	} = {},
): EditorSnapshot {
	const cursor = options.cursor ?? prefix.length;
	const before = prefix.slice(0, cursor);
	const lineStart = before.lastIndexOf('\n') + 1;
	const lineTextBefore = before.slice(lineStart);
	const suffix = options.suffix ?? '';
	const textAfterCursor = prefix.slice(cursor) + suffix;
	const lineEnd = textAfterCursor.indexOf('\n');
	const lineTextAfter = lineEnd === -1 ? textAfterCursor : textAfterCursor.slice(0, lineEnd);
	// Prefix in a real snapshot is capped but ends at the cursor; here it is the exact text so
	// absolute offsets and prefix indices line up.
	const prefixOffset = cursor - before.length;
	return {
		docId: options.docId ?? 'notes/math.md',
		docVersion: options.docVersion ?? 1,
		cursor,
		selectionFrom: cursor,
		selectionTo: cursor,
		prefix: before,
		prefixOffset,
		suffix: textAfterCursor,
		line: before.split('\n').length - 1,
		ch: lineTextBefore.length,
		lineTextBefore,
		lineTextAfter,
		isComposing: options.isComposing ?? false,
		timestamp: Date.now(),
		trigger: options.trigger ?? 'doc-change',
		lastEdit: options.lastEdit ?? null,
		language: 'markdown',
		mode: 'live',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

function baseConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
	return {
		baseDebounceMs: 50,
		minRequestIntervalMs: 0,
		maxOutputTokens: 256,
		requestTimeoutMs: 5_000,
		temperature: 0.2,
		cacheEntries: 16,
		contextCacheEntries: 8,
		debug: false,
		enabled: true,
		autoTrigger: true,
		minPrefixChars: 0,
		...overrides,
	};
}

interface Harness {
	scheduler: CompletionScheduler;
	adapter: FakeAdapter;
	telemetry: Telemetry;
	cache: LruPredictionCache;
	suggestions: ActiveSuggestion[];
	statuses: SchedulerStatus[];
	setConfig(patch: Partial<SchedulerConfig>): void;
}

function createHarness(adapter: FakeAdapter, overrides: Partial<SchedulerConfig> = {}): Harness {
	const telemetry = new Telemetry();
	const cache = new LruPredictionCache({ maxEntries: 16 });
	const contextBuilder = new ContextEngine({
		modelContextWindow: adapter.contextWindow,
		maxOutputTokens: 256,
	});
	const runner = new PredictionEngine({ adapter, maxSuggestionChars: 4_000 });
	const suggestions: ActiveSuggestion[] = [];
	const statuses: SchedulerStatus[] = [];
	let config = baseConfig(overrides);
	const scheduler = new CompletionScheduler({ timers: testTimers,
		contextBuilder,
		runner,
		cache,
		telemetry,
		getConfig: () => config,
		events: {
			onSuggestion: (suggestion) => {
				if (suggestion !== null) suggestions.push(suggestion);
			},
			onStatus: (status) => statuses.push(status),
		},
	});
	return {
		scheduler,
		adapter,
		telemetry,
		cache,
		suggestions,
		statuses,
		setConfig: (patch) => {
			config = { ...config, ...patch };
		},
	};
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('completion stack (scheduler + context + prediction + fake model)', () => {
	it('文中补全参考后文并在连续输入时保留衔接空格', async () => {
		const adapter = new FakeAdapter(() => modelResponse('quick brown '));
		const harness = createHarness(adapter);
		harness.scheduler.update(snapshot('The fox.', { cursor: 4 }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(adapter.calls).toHaveLength(1);
		expect(adapter.calls[0]?.messages[1]?.content).toContain('<cursor/>fox.</document-around-cursor>');
		expect(harness.scheduler.current()?.remainingText).toBe('quick brown ');

		harness.scheduler.update(snapshot('The quick fox.', { cursor: 10, docVersion: 2,
			lastEdit: { from: 4, to: 4, insertedText: 'quick ', removedLength: 0, at: Date.now() } }));
		expect(harness.scheduler.current()?.remainingText).toBe('brown ');
		expect(harness.scheduler.current()?.anchor).toBe(10);
		expect(adapter.calls).toHaveLength(1);
		expect('The quick ' + harness.scheduler.current()?.remainingText + 'fox.').toBe('The quick brown fox.');
		harness.scheduler.dispose();
	});

	it('turns one debounced edit into a validated suggestion with a structured prompt', async () => {
		const adapter = new FakeAdapter(() => modelResponse('方向上的缩放比例。'));
		const harness = createHarness(adapter);

		harness.scheduler.update(snapshot('特征值描述了线性变换在'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();

		expect(adapter.calls).toHaveLength(1);
		expect(harness.suggestions.at(-1)?.remainingText).toBe('方向上的缩放比例。');
		expect(harness.suggestions.at(-1)?.candidate.finishReason).toBe('stop');
		expect(harness.telemetry.snapshot().requests).toBe(1);
		expect(harness.telemetry.snapshot().inputTokens).toBe(120);

		const [system, user] = adapter.messages[0] ?? [];
		expect(system?.role).toBe('system');
		expect(system?.content).toContain('Untrusted data');
		expect(user?.role).toBe('user');
		expect(user?.content).toContain('<document-around-cursor>');
		expect(user?.content).toContain('特征值描述了线性变换在');
		expect(user?.content).toContain('<cursor/>');
	});

	it('drops a truncated suggestion instead of rendering it blindly', async () => {
		const adapter = new FakeAdapter(() => modelResponse('很长的推导过程', 'length'));
		const harness = createHarness(adapter);

		harness.scheduler.update(snapshot('当前段落'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();

		expect(adapter.calls).toHaveLength(1);
		// "很长的推导过程" has no sentence/line boundary; the validator refuses to show it.
		expect(harness.suggestions).toHaveLength(0);
		expect(harness.telemetry.snapshot().candidatesShown).toBe(0);
	});

	it('reuses the on-screen candidate while the user types its prefix (no second call)', async () => {
		const adapter = new FakeAdapter(() => modelResponse('world peace.'));
		const harness = createHarness(adapter);

		harness.scheduler.update(snapshot('Hello '));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();
		expect(adapter.calls).toHaveLength(1);
		expect(harness.suggestions.at(-1)?.remainingText).toBe('world peace.');

		harness.scheduler.update(
			snapshot('Hello world', {
				docVersion: 2,
				lastEdit: { from: 6, to: 6, insertedText: 'world', removedLength: 0, at: Date.now() },
			}),
		);

		expect(adapter.calls).toHaveLength(1);
		const latest = harness.suggestions.at(-1);
		expect(latest?.remainingText).toBe(' peace.');
		expect(latest?.anchor).toBe(11);
	});

	it('never calls the model when auto-triggering is disabled, but still allows requestNow', async () => {
		const adapter = new FakeAdapter(() => modelResponse('manual suggestion.'));
		const harness = createHarness(adapter, { autoTrigger: false });

		harness.scheduler.update(snapshot('Some text before'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();
		expect(adapter.calls).toHaveLength(0);
		expect(harness.suggestions).toHaveLength(0);

		harness.scheduler.requestNow();
		await vi.advanceTimersByTimeAsync(0);
		await flushAsync();
		expect(adapter.calls).toHaveLength(1);
		expect(harness.suggestions.at(-1)?.remainingText).toBe('manual suggestion.');
	});

	it('honours the master switch: disabled means no requests and no suggestions', async () => {
		const adapter = new FakeAdapter(() => modelResponse('should not appear'));
		const harness = createHarness(adapter, { enabled: false });

		harness.scheduler.update(snapshot('Some text'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();

		expect(adapter.calls).toHaveLength(0);
		expect(harness.suggestions).toHaveLength(0);
		expect(harness.statuses).toContain('disabled');
	});

	it('skips automatic requests until the minimum prefix length is reached', async () => {
		const adapter = new FakeAdapter(() => modelResponse('continuation'));
		const harness = createHarness(adapter, { minPrefixChars: 20 });

		harness.scheduler.update(snapshot('short'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();
		expect(adapter.calls).toHaveLength(0);

		harness.scheduler.update(snapshot('This prefix is definitely long enough'));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();
		expect(adapter.calls).toHaveLength(1);
	});

	it('suppresses requests during IME composition', async () => {
		const adapter = new FakeAdapter(() => modelResponse('不该出现'));
		const harness = createHarness(adapter);

		harness.scheduler.update(snapshot('拼音输入中', { isComposing: true }));
		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();

		expect(adapter.calls).toHaveLength(0);
		expect(harness.suggestions).toHaveLength(0);
	});
});
