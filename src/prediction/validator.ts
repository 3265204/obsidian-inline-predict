/**
 * Suggestion validator: the last line of defense before ghost text is shown.
 *
 * Two failure modes matter most:
 *  - The provider truncated the answer (`finish_reason: 'length'`). We must never show a
 *    half-finished sentence blindly, so truncated output is repaired at the last complete
 *    semantic boundary or rejected.
 *  - The model echoed text that already exists before the cursor. Inserting it would duplicate
 *    content, so it is rejected as `echo`.
 *
 * The validator never truncates silently: any repair marks the candidate `degraded` so telemetry
 * and diagnostics can tell repaired suggestions from clean ones.
 */
import { sanitizeControlCharacters } from '../core/text';
import type {
	EditorSnapshot,
	ModelResponse,
	PredictionSkipReason,
} from '../core/types';
import {
	endsWithHighSurrogate,
	lastCompleteBoundary,
	stripModelControlTokens,
} from '../core/text';
import { assessInsertionOffTopic } from './relatedness';

export interface ValidateInput {
	response: ModelResponse;
	snapshot: EditorSnapshot;
	maxChars: number;
	/**
	 * Reject long candidates that share no term with a short CJK context. Disabled by direct
	 * callers unless they opt in; the prediction engine passes the user setting.
	 */
	offTopicFilter?: boolean;
}

export interface ValidationResult {
	text: string | null;
	rejected: PredictionSkipReason | null;
	degraded: boolean;
}

/** A repaired suggestion below this size is not worth showing. */
const MIN_REPAIRED_CHARS = 8;
/** Keep at least this share of a truncated answer, otherwise it lost too much meaning. */
const MIN_REPAIR_RATIO = 0.4;

const FENCE_WRAP_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;

function normalize(text: string): string {
	return sanitizeControlCharacters(text.replace(/\r\n?/g, '\n'));
}

function rejected(reason: PredictionSkipReason, degraded: boolean): ValidationResult {
	return { text: null, rejected: reason, degraded };
}

/**
 * Cut truncated model output back to the last complete sentence/line. Returns null when no
 * usable boundary exists or too much of the answer would be lost.
 */
function repairTruncated(text: string): string | null {
	const boundary = lastCompleteBoundary(text, 0);
	if (boundary <= 0) return null;
	const repaired = text.slice(0, boundary).trimEnd();
	if (repaired.length < MIN_REPAIRED_CHARS) return null;
	if (repaired.length < Math.ceil(text.length * MIN_REPAIR_RATIO)) return null;
	return repaired;
}

/**
 * Enforce the character cap at a natural boundary. A hard slice is used when no boundary is
 * available; a result smaller than the minimum is rejected as too small to be useful.
 */
function truncateToLimit(text: string, maxChars: number): string | null {
	const window = text.slice(0, maxChars).trimEnd();
	if (window.length < MIN_REPAIRED_CHARS) return null;
	const boundary = lastCompleteBoundary(window, 0);
	const repaired = boundary > 0 ? window.slice(0, boundary).trimEnd() : window;
	return repaired.length >= MIN_REPAIRED_CHARS ? repaired : null;
}

/**
 * Remove a wrapping ``` fence the model added around its own answer. Only safe outside code
 * blocks — inside one, the fence is legitimate content.
 */
function stripWrapperFence(text: string): string {
	const match = FENCE_WRAP_RE.exec(text.trimEnd());
	if (!match) return text;
	return match[1] ?? '';
}

/** 文中插入的尾空白可能用于连接后文，不能像文末续写那样直接清掉。 */
function trimForInsertion(text: string, snapshot: EditorSnapshot): string {
	return snapshot.suffix.length > 0 ? text : text.trimEnd();
}

export function validateSuggestion(input: ValidateInput): ValidationResult {
	const { response, snapshot, maxChars } = input;
	// Providers (notably DeepSeek V4 reasoning models) can leak internal DSML tool-call markup
	// into content; it is never valid insertion text, so strip it before any other check.
	let text = trimForInsertion(stripModelControlTokens(normalize(response.text)), snapshot);
	let degraded = false;

	switch (response.finishReason) {
		case 'content_filter':
		case 'tool_calls':
			// Structured/tool output is not insertion text for the document.
			return rejected('validator-rejected', false);
		case 'error':
			return rejected('error', false);
		case 'unknown':
			// Providers that omit finish_reason cannot prove the answer completed.
			return rejected('validator-rejected', false);
		case 'length':
			break;
		case 'stop':
			break;
	}

	if (text.trim().length === 0) return rejected('empty', degraded);

	if (response.finishReason === 'length') {
		degraded = true;
		const repaired = repairTruncated(text);
		if (repaired === null) return rejected('truncated', degraded);
		text = repaired;
	}

	const limit = Math.max(1, Math.floor(maxChars));
	if (text.length > limit) {
		degraded = true;
		const truncated = truncateToLimit(text, limit);
		if (truncated === null) return rejected('truncated', degraded);
		text = truncated;
	}

	if (!snapshot.inCodeBlock) {
		const stripped = trimForInsertion(stripWrapperFence(text), snapshot);
		if (stripped !== text) {
			text = stripped;
			if (text.trim().length === 0) return rejected('empty', degraded);
		}
	}

	if (snapshot.prefix.length > 0 && snapshot.prefix.endsWith(text.trimEnd())) return rejected('echo', degraded);

	// Never hand the editor a dangling high surrogate: insertion would corrupt the document.
	if (endsWithHighSurrogate(text)) text = trimForInsertion(text.slice(0, -1), snapshot);

	if (input.offTopicFilter === true) {
		if (snapshot.prefix.trim().length > 0 || snapshot.suffix.trim().length > 0) {
			const assessment = assessInsertionOffTopic(snapshot.prefix, snapshot.suffix, text);
			if (assessment.assessed && assessment.offTopic) {
				// Keep the cleaned text: the prediction engine may ask the model-based relevance
				// judge whether this lexically-disjoint candidate is actually related.
				return { text, rejected: 'off-topic', degraded };
			}
		}
	}
	if (text.trim().length === 0) return rejected('empty', degraded);

	return { text, rejected: null, degraded };
}
