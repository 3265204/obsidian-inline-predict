/**
 * Unicode-safe text helpers shared by the editor integration, validation and context code.
 *
 * Everything here operates on JS code units but refuses to split a surrogate pair. That is the
 * failure mode we care about: a ghost-text remainder that starts with half an emoji or a
 * partial grapheme will corrupt the acceptance insertion.
 */

export function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** True when `text` ends with a lone high surrogate (cannot be inserted safely). */
export function endsWithHighSurrogate(text: string): boolean {
	if (text.length === 0) return false;
	return isHighSurrogate(text.charCodeAt(text.length - 1));
}

export function codePointLength(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		count++;
		if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < text.length) i++;
	}
	return count;
}

/**
 * Longest common prefix length in code units, never returning an index that splits a
 * surrogate pair.
 */
export function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i > 0 && i < a.length && isLowSurrogate(a.charCodeAt(i)) && isHighSurrogate(a.charCodeAt(i - 1))) {
		return i - 1;
	}
	return i;
}

/**
 * Incremental completion: return the not-yet-typed remainder of `candidate` when `typed` is a
 * valid prefix, otherwise null (candidate no longer applies).
 *
 * Rejects matches that would leave half a surrogate pair, and rejects when `typed` itself ends
 * with a lone high surrogate.
 */
export function matchTypedPrefix(candidate: string, typed: string): string | null {
	if (typed.length === 0) return candidate;
	if (typed.length > candidate.length) return null;
	if (endsWithHighSurrogate(typed)) return null;
	if (!candidate.startsWith(typed)) return null;
	if (typed.length > 0 && isHighSurrogate(candidate.charCodeAt(typed.length - 1))) return null;
	return candidate.slice(typed.length);
}

/* ------------------------------------------------------------------ */
/* Segmentation                                                        */
/* ------------------------------------------------------------------ */

type SegmenterCtor = new (
	locale?: string,
	options?: { granularity: 'grapheme' | 'word' | 'sentence' },
) => { segment(input: string): Iterable<{ segment: string; index: number }> };

interface SegmenterLike {
	segment(input: string): Iterable<{ segment: string; index: number }>;
}

const segmenterCache = new Map<string, SegmenterLike | null>();

function getSegmenter(granularity: 'grapheme' | 'word' | 'sentence'): SegmenterLike | null {
	const cached = segmenterCache.get(granularity);
	if (cached !== undefined) return cached;
	const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
	const instance = ctor ? new ctor(undefined, { granularity }) : null;
	segmenterCache.set(granularity, instance);
	return instance;
}

/** Split into user-perceived characters. Falls back to code points when Intl.Segmenter is absent. */
export function segmentGraphemes(text: string): string[] {
	const segmenter = getSegmenter('grapheme');
	if (!segmenter) {
		const out: string[] = [];
		for (const ch of text) out.push(ch);
		return out;
	}
	return Array.from(segmenter.segment(text), (s) => s.segment);
}

const CJK_RE =
	/[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

export function isCjkChar(ch: string): boolean {
	return CJK_RE.test(ch);
}

export function isWordChar(ch: string): boolean {
	return WORD_CHAR_RE.test(ch);
}

const TRAILING_SPACE_RE = /[ \t]+/y;

function consumeTrailingSpaces(text: string, from: number): number {
	TRAILING_SPACE_RE.lastIndex = from;
	const match = TRAILING_SPACE_RE.exec(text);
	return match ? from + match[0].length : from;
}

function codePointAt(text: string, index: number): string {
	const code = text.codePointAt(index);
	return code === undefined ? '' : String.fromCodePoint(code);
}

/**
 * End offset of the next "word" in `text` (0-based start assumed). For CJK a word is a short
 * run of characters (2 for Han runs) so partial accept feels natural; Latin runs include
 * digits/underscore and trailing spaces.
 */
export function nextWordEnd(text: string): number {
	if (text.length === 0) return 0;
	const first = codePointAt(text, 0);
	if (isCjkChar(first)) {
		// Accept one CJK code point at a time; partial accept at character granularity is what
		// users expect, and "word" segmentation for Chinese is not well defined in the browser.
		return first.length;
	}
	let i = 0;
	while (i < text.length) {
		const ch = codePointAt(text, i);
		if (isWordChar(ch) || ch === "'" || ch === '-' || ch === '’') {
			i += ch.length;
			continue;
		}
		break;
	}
	if (i === 0) {
		// Leading punctuation: accept it together with following spaces, so a sentence start works.
		const ch = codePointAt(text, 0);
		return ch.length;
	}
	return consumeTrailingSpaces(text, i);
}

const SENTENCE_END_CHARS = new Set(['.', '!', '?', '。', '！', '？', '…', ';', '；', ':', '：']);
const CLOSING_CHARS = new Set(['"', "'", '”', '’', ')', ']', '}', '》', '」', '』']);

/** End offset of the next sentence (including trailing whitespace, not crossing blank lines). */
export function nextSentenceEnd(text: string): number {
	if (text.length === 0) return 0;
	let i = 0;
	while (i < text.length) {
		const ch = codePointAt(text, i);
		i += ch.length;
		if (!SENTENCE_END_CHARS.has(ch)) continue;
		// Consume repeated terminators ("?!", "……") and closing quotes/brackets.
		while (i < text.length) {
			const c = codePointAt(text, i);
			if (SENTENCE_END_CHARS.has(c) || CLOSING_CHARS.has(c)) {
				i += c.length;
			} else {
				break;
			}
		}
		i = consumeTrailingSpaces(text, i);
		return i;
	}
	return text.length;
}

/** End offset of the next line (exclusive of the newline) or end of text. */
export function nextLineEnd(text: string): number {
	const idx = text.indexOf('\n');
	return idx === -1 ? text.length : idx;
}

/** End offset of the next paragraph break or end of text. */
export function nextParagraphEnd(text: string): number {
	const idx = text.indexOf('\n\n');
	return idx === -1 ? text.length : idx;
}

/**
 * Last complete semantic boundary at or before `text.length`. Used to repair truncated model
 * output: returns the cut index, or -1 when no boundary exists far enough into the text.
 */
export function lastCompleteBoundary(text: string, minChars = 1): number {
	if (text.length === 0) return -1;
	for (let i = text.length - 1; i >= Math.max(0, minChars); i--) {
		const ch = text[i];
		if (ch === undefined) continue;
		if (SENTENCE_END_CHARS.has(ch)) {
			let end = i + 1;
			while (end < text.length) {
				const c = text[end];
				if (c !== undefined && (SENTENCE_END_CHARS.has(c) || CLOSING_CHARS.has(c))) end++;
				else break;
			}
			return end;
		}
		if (ch === '\n') return i;
	}
	return -1;
}

/**
 * Count trailing whitespace/newlines, used to keep markdown block structure sane when inserting
 * a suggestion at the cursor.
 */
export function trailingWhitespaceLength(text: string): number {
	let count = 0;
	for (let i = text.length - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') count++;
		else break;
	}
	return count;
}

/* ------------------------------------------------------------------ */
/* Model control-token leakage                                         */
/* ------------------------------------------------------------------ */

/**
 * DeepSeek V4 models occasionally leak internal DSML tool-call markup into `content` instead of
 * parsing it as a tool call (known upstream bug). The markup uses full-width bars, e.g.
 * `</｜｜DSML｜｜ parameter>`. Such fragments are never valid insertion text, so they are removed
 * before validation. Ordinary HTML/Markdown is left untouched.
 */
export function stripModelControlTokens(text: string): string {
	return (
		text
			// Any tag-like fragment containing a full-width bar: covers DSML invoke/parameter markup.
			.replace(/<\/?[^<>]{0,200}?｜[^<>]{0,200}?>/g, '')
			// Bare DSML marker without angle brackets (partial leaks).
			.replace(/｜{2}\s*DSML\s*｜{2}[^\s<]*/gi, '')
			// ASCII special tokens such as <|endoftext|> / <|im_end|>.
			.replace(/<\|[^<>]{1,80}\|>/g, '')
			// Single-delimiter full-width tokens such as <｜tool▁calls｜>.
			.replace(/<｜[^<>]{1,80}｜>/g, '')
	);
}
