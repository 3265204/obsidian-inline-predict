/**
 * Adaptive trigger policy.
 *
 * Pure decision function: given the latest editor snapshot and recent scheduler history, decide
 * whether to call the model now, after how long, or not at all. Keeping it pure makes the debounce
 * rules unit-testable without any timers or editor.
 *
 * Signals, in decreasing importance:
 * 1. IME composition → never request.
 * 2. Backoff after failures → exponential wait, no per-keystroke retry storm.
 * 3. Semantic boundary (heading, new paragraph, list start, sentence end, file open, explicit
 *    command) → short delay: the user is at a natural place for a continuation.
 * 4. Typing speed → fast typing stretches the debounce (the user is mid-flow), slow typing
 *    shortens it (the user is pausing, a suggestion is more likely wanted).
 * 5. Recent p50 latency → if the provider is slow, wait longer instead of queueing requests.
 * 6. Minimum interval since the last request → hard floor, regardless of the above.
 */

import type { EditorSnapshot } from '../core/types';
import {
	BACKOFF_BASE_MS,
	BACKOFF_MAX_MS,
} from '../core/constants';
import { isWordChar } from '../core/text';

export type TriggerAction = 'request' | 'wait' | 'skip';

export type TriggerReason =
	| 'composing'
	| 'manual-request'
	| 'semantic-boundary'
	| 'file-open'
	| 'typing-pace'
	| 'min-interval'
	| 'backoff';

export interface TriggerDecision {
	action: TriggerAction;
	/** 0 when `action === 'request'`; otherwise the debounce/backoff delay to schedule. */
	delayMs: number;
	reason: TriggerReason;
	priority: 'high' | 'normal';
}

export interface TriggerPolicyInput {
	snapshot: EditorSnapshot;
	/** Milliseconds timestamp; injected so tests never depend on the wall clock. */
	now: number;
	baseDebounceMs: number;
	minRequestIntervalMs: number;
	lastRequestAt: number | null;
	/** Consecutive failures since the last success (0 = healthy). */
	failedAttempts: number;
	/** Recent inter-edit intervals in ms (any order); callers cap the history. */
	interEditIntervalsMs?: readonly number[];
	p50LatencyMs?: number | null;
	/** True for an explicit user command (`requestNow`): skips debounce, not composition/backoff. */
	force?: boolean;
}

/** Boundary requests fire at this fraction of the base debounce. */
export const BOUNDARY_DEBOUNCE_FACTOR = 0.4;
/** Opening a file is an even stronger signal that a suggestion is welcome. */
export const FILE_OPEN_DEBOUNCE_FACTOR = 0.25;
/** Ordinary mid-word typing waits a little longer than a completed word. */
export const MID_WORD_DEBOUNCE_FACTOR = 1.25;
/** Hard ceiling on adaptive stretching, so a fast typist never waits absurdly long. */
export const MAX_DEBOUNCE_FACTOR = 2.5;
export const MIN_TYPING_MULTIPLIER = 0.7;
export const MAX_TYPING_MULTIPLIER = 1.8;
/** Pauses longer than this are not "typing speed"; they are context switches. */
export const MAX_EDIT_INTERVAL_MS = 2000;
/** Above this p50, add debounce in proportion to how slow the provider is. */
export const HIGH_LATENCY_MS = 900;
export const MAX_LATENCY_DEBOUNCE_FACTOR = 1.75;
export const LATENCY_DEBOUNCE_PER_MS = 1 / 4000;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Median of a list of numbers (null for an empty list). Does not mutate the input. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	const low = sorted[mid - 1];
	const high = sorted[mid];
	if (low === undefined || high === undefined) return null;
	return (low + high) / 2;
}

/** Median inter-edit interval of real typing bursts (long pauses ignored). */
export function medianInterEditInterval(intervals: readonly number[]): number | null {
	const usable = intervals.filter(
		(value) => Number.isFinite(value) && value > 0 && value <= MAX_EDIT_INTERVAL_MS,
	);
	return median(usable);
}

/**
 * Fast typing (small median interval) stretches the debounce; slow typing shortens it.
 * No history → neutral 1.0.
 */
export function typingSpeedMultiplier(intervals: readonly number[]): number {
	const medianInterval = medianInterEditInterval(intervals);
	if (medianInterval === null) return 1;
	// 60 ms/char → ~1.68×, 250 ms/char → ~1.3×, 500 ms/char → 0.8×, 750 ms/char → 0.7×.
	const raw = 1.8 - medianInterval / 500;
	return clamp(raw, MIN_TYPING_MULTIPLIER, MAX_TYPING_MULTIPLIER);
}

/** Stretch the debounce when the provider has been slow recently. */
export function latencyMultiplier(p50LatencyMs: number | null | undefined): number {
	if (p50LatencyMs === null || p50LatencyMs === undefined) return 1;
	if (!Number.isFinite(p50LatencyMs) || p50LatencyMs <= HIGH_LATENCY_MS) return 1;
	return clamp(
		1 + (p50LatencyMs - HIGH_LATENCY_MS) * LATENCY_DEBOUNCE_PER_MS,
		1,
		MAX_LATENCY_DEBOUNCE_FACTOR,
	);
}

/** Exponential backoff for the n-th consecutive failure (1-based), capped. */
export function backoffDelayMs(attempts: number): number {
	const n = Math.max(1, Math.floor(attempts));
	const exponent = Math.min(n - 1, 20);
	return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

export type SemanticBoundary = 'manual' | 'file-open' | 'paragraph' | 'heading' | 'list' | 'sentence';

const LIST_MARKER_ONLY_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+\S/;
const PARAGRAPH_END_RE = /\r?\n[ \t]*\r?\n$/;
const SENTENCE_END_RE = /[.!?。！？…;；:：]["'”’)\]}》」』]?$/;

/** Line above the cursor's current line (empty string when there is none). */
function previousLine(prefix: string): string {
	const currentLineStart = prefix.lastIndexOf('\n') + 1;
	if (currentLineStart === 0) return '';
	const previousEnd = currentLineStart - 1; // index of the newline ending the previous line
	const previousStart = prefix.lastIndexOf('\n', previousEnd - 1) + 1;
	return prefix.slice(previousStart, previousEnd);
}

function lastCodePoint(text: string): string {
	if (text.length === 0) return '';
	const code = text.codePointAt(text.length - 1);
	if (code === undefined) return '';
	// If the final code unit is a low surrogate, codePointAt returns it alone; that cannot be a
	// word character, which is exactly what we want here.
	return String.fromCodePoint(code);
}

/** True when the cursor sits inside/at the end of a word rather than after a boundary. */
export function isMidWordTyping(lineTextBefore: string): boolean {
	if (lineTextBefore.length === 0) return false;
	return isWordChar(lastCodePoint(lineTextBefore));
}

/**
 * Detect a "natural continuation point". `null` means ordinary typing mid-sentence.
 * Only inspected text is used; no document access.
 */
export function detectSemanticBoundary(snapshot: EditorSnapshot): SemanticBoundary | null {
	if (snapshot.trigger === 'manual') return 'manual';
	if (snapshot.trigger === 'file-open') return 'file-open';
	if (PARAGRAPH_END_RE.test(snapshot.prefix)) return 'paragraph';

	const currentLine = snapshot.lineTextBefore;
	if (currentLine.trim().length === 0) {
		if (HEADING_RE.test(previousLine(snapshot.prefix).trimStart())) return 'heading';
	}
	if (LIST_MARKER_ONLY_RE.test(currentLine)) return 'list';
	const trimmedLine = currentLine.replace(/[ \t]+$/, '');
	if (trimmedLine.length > 0 && SENTENCE_END_RE.test(trimmedLine)) return 'sentence';
	return null;
}

function backoffDecision(attempts: number): TriggerDecision {
	return {
		action: 'wait',
		delayMs: backoffDelayMs(attempts),
		reason: 'backoff',
		priority: 'normal',
	};
}

/**
 * Decide what the scheduler should do with this snapshot.
 *
 * `action: 'request'` means "call now" (delay is 0); `'wait'` means "schedule a timer for
 * `delayMs`"; `'skip'` means "do nothing" (composition). The scheduler clears any pending timer
 * before acting on the decision.
 */
export function decideTrigger(input: TriggerPolicyInput): TriggerDecision {
	const { snapshot } = input;
	if (snapshot.isComposing) {
		return { action: 'skip', delayMs: 0, reason: 'composing', priority: 'normal' };
	}

	const attempts = Math.max(0, Math.floor(input.failedAttempts));
	if (input.force === true) {
		if (attempts > 0) return backoffDecision(attempts);
		return { action: 'request', delayMs: 0, reason: 'manual-request', priority: 'high' };
	}
	if (attempts > 0) return backoffDecision(attempts);

	const base = Math.max(0, input.baseDebounceMs);
	const boundary = detectSemanticBoundary(snapshot);
	let delay: number;
	let reason: TriggerReason;
	let priority: TriggerDecision['priority'];

	if (boundary === 'manual') {
		return { action: 'request', delayMs: 0, reason: 'manual-request', priority: 'high' };
	}
	if (boundary === 'file-open') {
		delay = base * FILE_OPEN_DEBOUNCE_FACTOR;
		reason = 'file-open';
		priority = 'high';
	} else if (boundary !== null) {
		delay = base * BOUNDARY_DEBOUNCE_FACTOR;
		reason = 'semantic-boundary';
		priority = 'high';
	} else {
		const typing = typingSpeedMultiplier(input.interEditIntervalsMs ?? []);
		const latency = latencyMultiplier(input.p50LatencyMs);
		let factor = typing * latency;
		if (isMidWordTyping(snapshot.lineTextBefore)) factor *= MID_WORD_DEBOUNCE_FACTOR;
		factor = Math.min(factor, MAX_DEBOUNCE_FACTOR);
		delay = base * factor;
		reason = 'typing-pace';
		priority = 'normal';
	}

	delay = Math.max(0, Math.round(delay));

	// Hard floor: never fire two requests closer together than the configured interval.
	if (input.lastRequestAt !== null) {
		const elapsed = Math.max(0, input.now - input.lastRequestAt);
		const minInterval = Math.max(0, input.minRequestIntervalMs);
		if (elapsed < minInterval) {
			const needed = minInterval - elapsed;
			if (needed > delay) {
				delay = Math.ceil(needed);
				reason = 'min-interval';
			}
		}
	}

	return {
		action: delay <= 0 ? 'request' : 'wait',
		delayMs: delay,
		reason,
		priority,
	};
}

/** Injectable-clock wrapper; the scheduler keeps one instance for the session. */
export class TriggerPolicy {
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? (() => Date.now());
	}

	decide(input: Omit<TriggerPolicyInput, 'now'> & { now?: number }): TriggerDecision {
		return decideTrigger({ ...input, now: input.now ?? this.now() });
	}
}
