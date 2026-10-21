/**
 * Heuristic token estimation.
 *
 * There is deliberately no tiktoken/JS encoder in the bundle: it would add weight and still be
 * wrong for non-OpenAI providers. The heuristic only has to be *conservative enough* for the
 * budget manager (never under-count badly) and *stable* so prompt-cache keys and diagnostics do
 * not jitter. Provider-reported usage always wins for accounting (see `TokenUsage.estimated`).
 */

import type { ChatMessage, ChatTokenCounter } from '../core/types';
import { isCjkChar } from '../core/text';

/** ASCII/Latin text averages roughly 4 characters per token for GPT-family tokenizers. */
const LATIN_CHARS_PER_TOKEN = 4;
/** Chat framing cost per message (role marker, separators). */
const CHAT_MESSAGE_OVERHEAD_TOKENS = 4;
/** One-off framing for the assistant turn being generated. */
const CHAT_REPLY_PRIMING_TOKENS = 3;
/** Conservative cost for a non-CJK, non-ASCII code point (emoji, other scripts, symbols). */
const OTHER_UNICODE_TOKENS_PER_CODE_POINT = 2;

/**
 * Estimate tokens for a plain text fragment. Deterministic and pure.
 *
 * - CJK (Han/Kana/Hangul/full-width punctuation): ~1 token per code point.
 * - ASCII/Latin: ~4 characters per token (rounded up for the Latin run).
 * - Other Unicode: 2 tokens per code point (conservative: emoji and many scripts tokenize worse
 *   than one token per character).
 *
 * Non-empty text never estimates to 0 so gates that treat "0 tokens" as "nothing to send" are
 * not tripped by a single space or punctuation mark.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	let latinChars = 0;
	let cjkChars = 0;
	let otherCodePoints = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i);
		if (code === undefined) break;
		const ch = String.fromCodePoint(code);
		if (code > 0xffff) i++; // consume the low surrogate of the pair
		if (isCjkChar(ch)) {
			cjkChars++;
		} else if (code < 0x80) {
			latinChars++;
		} else {
			otherCodePoints++;
		}
	}
	const total =
		cjkChars +
		Math.ceil(latinChars / LATIN_CHARS_PER_TOKEN) +
		otherCodePoints * OTHER_UNICODE_TOKENS_PER_CODE_POINT;
	return Math.max(1, total);
}

/**
 * Default `ChatTokenCounter`. Counts exactly like a chat request so the budget manager and
 * telemetry can compare estimated prompt size against provider usage for the same request.
 */
export class HeuristicTokenCounter implements ChatTokenCounter {
	readonly id = 'heuristic-v1';

	count(text: string): number {
		return estimateTokens(text);
	}

	countMessages(messages: readonly ChatMessage[]): number {
		if (messages.length === 0) return 0;
		let total = CHAT_REPLY_PRIMING_TOKENS;
		for (const message of messages) {
			total += CHAT_MESSAGE_OVERHEAD_TOKENS + this.count(message.content);
		}
		return total;
	}
}

/** Shared instance: stateless, so callers do not need to allocate one per request. */
export const heuristicTokenCounter = new HeuristicTokenCounter();
