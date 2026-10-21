import { describe, expect, it } from 'vitest';
import {
	BOUNDARY_DEBOUNCE_FACTOR,
	FILE_OPEN_DEBOUNCE_FACTOR,
	TriggerPolicy,
	backoffDelayMs,
	decideTrigger,
	detectSemanticBoundary,
	latencyMultiplier,
	median,
	medianInterEditInterval,
	typingSpeedMultiplier,
} from '../../src/scheduler/trigger-policy';
import type { EditorSnapshot, SnapshotTrigger } from '../../src/core/types';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MIN_REQUEST_INTERVAL_MS } from '../../src/core/constants';

function snapshot(
	prefix: string,
	options: { trigger?: SnapshotTrigger; isComposing?: boolean; lineTextBefore?: string } = {},
): EditorSnapshot {
	const lastNewline = prefix.lastIndexOf('\n');
	const lineTextBefore =
		options.lineTextBefore ?? (lastNewline === -1 ? prefix : prefix.slice(lastNewline + 1));
	const cursor = prefix.length;
	return {
		docId: 'notes/test.md',
		docVersion: 1,
		cursor,
		selectionFrom: cursor,
		selectionTo: cursor,
		prefix,
		prefixOffset: 0,
		suffix: '',
		line: 0,
		ch: cursor,
		lineTextBefore,
		lineTextAfter: '',
		isComposing: options.isComposing ?? false,
		timestamp: 0,
		trigger: options.trigger ?? 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

const BASE = 400;

function decide(
	prefix: string,
	options: {
		now?: number;
		lastRequestAt?: number | null;
		failedAttempts?: number;
		intervals?: number[];
		p50?: number | null;
		force?: boolean;
		trigger?: SnapshotTrigger;
		isComposing?: boolean;
		lineTextBefore?: string;
	} = {},
) {
	return decideTrigger({
		snapshot: snapshot(prefix, {
			trigger: options.trigger,
			isComposing: options.isComposing,
			lineTextBefore: options.lineTextBefore,
		}),
		now: options.now ?? 10_000,
		baseDebounceMs: BASE,
		minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
		lastRequestAt: options.lastRequestAt ?? null,
		failedAttempts: options.failedAttempts ?? 0,
		interEditIntervalsMs: options.intervals ?? [],
		p50LatencyMs: options.p50 ?? null,
		force: options.force,
	});
}

describe('decideTrigger: composition and manual', () => {
	it('skips while IME composition is active', () => {
		const decision = decide('hello', { isComposing: true });
		expect(decision).toMatchObject({ action: 'skip', delayMs: 0, reason: 'composing' });
	});

	it('requests immediately for an explicit manual trigger', () => {
		const decision = decide('hello', { trigger: 'manual' });
		expect(decision).toEqual({
			action: 'request',
			delayMs: 0,
			reason: 'manual-request',
			priority: 'high',
		});
	});

	it('force bypasses debounce but not composition', () => {
		expect(decide('hello', { force: true })).toMatchObject({ action: 'request', delayMs: 0 });
		expect(decide('hello', { force: true, isComposing: true }).action).toBe('skip');
	});

	it('requests immediately when the configured debounce is zero', () => {
		const decision = decideTrigger({
			snapshot: snapshot('hello '),
			now: 0,
			baseDebounceMs: 0,
			minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
			lastRequestAt: null,
			failedAttempts: 0,
		});
		expect(decision.action).toBe('request');
		expect(decision.delayMs).toBe(0);
	});
});

describe('decideTrigger: semantic boundaries', () => {
	it('boosts the delay after sentence-ending punctuation', () => {
		const decision = decide('Done. ');
		expect(decision.action).toBe('wait');
		expect(decision.delayMs).toBe(BASE * BOUNDARY_DEBOUNCE_FACTOR);
		expect(decision.reason).toBe('semantic-boundary');
		expect(decision.priority).toBe('high');
	});

	it('boosts after a new paragraph', () => {
		expect(decide('Some text\n\n')).toMatchObject({
			delayMs: BASE * BOUNDARY_DEBOUNCE_FACTOR,
			reason: 'semantic-boundary',
			priority: 'high',
		});
	});

	it('boosts on an empty line after a heading', () => {
		expect(decide('# Chapter\n')).toMatchObject({
			delayMs: BASE * BOUNDARY_DEBOUNCE_FACTOR,
			reason: 'semantic-boundary',
		});
	});

	it('boosts at a list item start', () => {
		expect(decide('- ')).toMatchObject({
			delayMs: BASE * BOUNDARY_DEBOUNCE_FACTOR,
			reason: 'semantic-boundary',
		});
	});

	it('boosts on file open', () => {
		const decision = decide('', { trigger: 'file-open' });
		expect(decision).toMatchObject({
			delayMs: BASE * FILE_OPEN_DEBOUNCE_FACTOR,
			reason: 'file-open',
			priority: 'high',
		});
	});

	it('treats ordinary mid-word typing as the slowest ordinary case', () => {
		const decision = decide('hello');
		expect(decision.reason).toBe('typing-pace');
		expect(decision.priority).toBe('normal');
		expect(decision.delayMs).toBeGreaterThanOrEqual(BASE);
	});
});

describe('decideTrigger: typing speed and latency', () => {
	it('stretches the debounce while the user types quickly', () => {
		const fast = decide('hello ', { intervals: [90, 100, 110, 105] });
		const neutral = decide('hello ');
		expect(fast.delayMs).toBeGreaterThan(neutral.delayMs);
	});

	it('shortens the debounce when the user is pausing', () => {
		const slow = decide('hello ', { intervals: [480, 520, 500] });
		const neutral = decide('hello ');
		expect(slow.delayMs).toBeLessThan(neutral.delayMs);
	});

	it('ignores long pauses when estimating typing speed', () => {
		expect(medianInterEditInterval([100, 100, 5000, 100])).toBe(100);
		expect(medianInterEditInterval([])).toBeNull();
	});

	it('adds debounce when recent p50 latency is high', () => {
		const slowProvider = decide('hello ', { p50: 2400 });
		const fastProvider = decide('hello ');
		expect(slowProvider.delayMs).toBeGreaterThan(fastProvider.delayMs);
	});

	it('caps combined stretching at the maximum factor', () => {
		const decision = decide('hello', {
			intervals: [40, 40, 40],
			p50: 60_000,
		});
		expect(decision.delayMs).toBe(BASE * 2.5);
	});
});

describe('decideTrigger: minimum interval', () => {
	it('delays a request until the minimum interval has elapsed', () => {
		const decision = decide('Done. ', { now: 10_000, lastRequestAt: 9_900 });
		// Boundary delay would be 160 ms; the min interval (350 ms) needs 250 ms more.
		expect(decision.delayMs).toBe(MIN_REQUEST_INTERVAL_MS - 100);
		expect(decision.reason).toBe('min-interval');
	});

	it('keeps a larger adaptive delay when the interval is already satisfied', () => {
		const decision = decide('hello ', { now: 10_000, lastRequestAt: 9_660 });
		expect(decision.delayMs).toBe(BASE);
		expect(decision.reason).toBe('typing-pace');
	});

	it('does not apply the interval to the first request', () => {
		expect(decide('hello ', { now: 500, lastRequestAt: null }).delayMs).toBe(BASE);
	});
});

describe('decideTrigger: failure backoff', () => {
	it('waits with exponential backoff after failures', () => {
		const first = decide('hello ', { failedAttempts: 1 });
		expect(first).toMatchObject({ action: 'wait', delayMs: BACKOFF_BASE_MS, reason: 'backoff' });
		expect(decide('hello ', { failedAttempts: 2 }).delayMs).toBe(BACKOFF_BASE_MS * 2);
		expect(decide('hello ', { failedAttempts: 3 }).delayMs).toBe(BACKOFF_BASE_MS * 4);
	});

	it('caps backoff', () => {
		expect(decide('hello ', { failedAttempts: 20 }).delayMs).toBe(BACKOFF_MAX_MS);
	});

	it('applies backoff even to explicit manual triggers, but not to force after recovery', () => {
		expect(decide('hello', { trigger: 'manual', failedAttempts: 1 }).reason).toBe('backoff');
		expect(decide('hello', { force: true, failedAttempts: 2 }).delayMs).toBe(BACKOFF_BASE_MS * 2);
		expect(decide('hello', { force: true, failedAttempts: 0 }).action).toBe('request');
	});

	it('backoffDelayMs follows the documented schedule', () => {
		expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
		expect(backoffDelayMs(2)).toBe(BACKOFF_BASE_MS * 2);
		expect(backoffDelayMs(5)).toBe(BACKOFF_BASE_MS * 16);
		expect(backoffDelayMs(100)).toBe(BACKOFF_MAX_MS);
	});
});

describe('policy helpers', () => {
	it('median handles odd and even lengths', () => {
		expect(median([])).toBeNull();
		expect(median([3])).toBe(3);
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	it('typingSpeedMultiplier goes up when fast and down when slow', () => {
		expect(typingSpeedMultiplier([])).toBe(1);
		expect(typingSpeedMultiplier([80, 80])).toBeGreaterThan(1);
		expect(typingSpeedMultiplier([450, 500])).toBeLessThan(1);
		expect(typingSpeedMultiplier([0, -5])).toBe(1);
	});

	it('latencyMultiplier is neutral below the threshold and capped above it', () => {
		expect(latencyMultiplier(null)).toBe(1);
		expect(latencyMultiplier(500)).toBe(1);
		expect(latencyMultiplier(2000)).toBeGreaterThan(1);
		expect(latencyMultiplier(100_000)).toBeLessThanOrEqual(1.75);
	});

	it('detectSemanticBoundary classifies common snapshot shapes', () => {
		expect(detectSemanticBoundary(snapshot('a\n\n'))).toBe('paragraph');
		expect(detectSemanticBoundary(snapshot('# H\n'))).toBe('heading');
		expect(detectSemanticBoundary(snapshot('# H\n  '))).toBe('heading');
		expect(detectSemanticBoundary(snapshot('- '))).toBe('list');
		expect(detectSemanticBoundary(snapshot('One. '))).toBe('sentence');
		expect(detectSemanticBoundary(snapshot('mid-word'))).toBeNull();
		expect(detectSemanticBoundary(snapshot('', { trigger: 'file-open' }))).toBe('file-open');
	});

	it('TriggerPolicy wraps decideTrigger with an injected clock', () => {
		const policy = new TriggerPolicy({ now: () => 10_050 });
		const decision = policy.decide({
			snapshot: snapshot('Done. '),
			baseDebounceMs: BASE,
			minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
			lastRequestAt: 9_900,
			failedAttempts: 0,
		});
		expect(decision.delayMs).toBe(MIN_REQUEST_INTERVAL_MS - 150);
	});
});
