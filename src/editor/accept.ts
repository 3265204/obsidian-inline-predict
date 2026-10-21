/**
 * Suggestion acceptance: compute a Unicode-safe slice and, for the UI side, insert exactly the
 * accepted text through a normal CM6 transaction.
 *
 * Boundaries come from `core/text` so the scheduler, validator and editor agree on what a word
 * or sentence is. Accepting must always make progress (never return an empty slice for non-empty
 * text) and must never split a surrogate pair: half an emoji in the document would be corruption.
 */

import type { EditorView } from '@codemirror/view';
import {
	isHighSurrogate,
	isLowSurrogate,
	nextLineEnd,
	nextParagraphEnd,
	nextSentenceEnd,
	nextWordEnd,
} from '../core/text';
import type { ActiveSuggestion } from '../core/types';

export type AcceptGranularity = 'word' | 'sentence' | 'line' | 'paragraph';

export interface AcceptSlice {
	accepted: string;
	remaining: string;
}

export interface AcceptResult {
	accepted: string;
	remaining: string | null;
}

/** Length in code units of the code point starting at `index`. */
function codePointWidth(text: string, index: number): number {
	const code = text.codePointAt(index);
	if (code === undefined) return 1;
	return code > 0xffff ? 2 : 1;
}

/**
 * Whitespace at the start of a suggestion belongs with the following word: accepting " world"
 * should not insert only the space.
 */
function wordBoundary(text: string): number {
	let start = 0;
	while (start < text.length) {
		const ch = text[start];
		if (ch !== ' ' && ch !== '\t') break;
		start++;
	}
	if (start === text.length) return text.length;
	return start + nextWordEnd(text.slice(start));
}

/** Paragraph breaks with CRLF are not matched by `nextParagraphEnd`; handle them here. */
function paragraphBoundary(text: string): number {
	const plain = nextParagraphEnd(text);
	if (plain < text.length) return plain + 2;
	const match = /\r?\n\r?\n/.exec(text);
	return match === null ? text.length : match.index + match[0].length;
}

function rawBoundary(text: string, granularity: AcceptGranularity): number {
	switch (granularity) {
		case 'word':
			return wordBoundary(text);
		case 'sentence':
			return nextSentenceEnd(text);
		case 'line': {
			const end = nextLineEnd(text);
			// Include the line break so repeated "accept line" keeps flowing downwards.
			return end < text.length ? end + 1 : end;
		}
		case 'paragraph':
			return paragraphBoundary(text);
	}
}

/**
 * Clamp a raw boundary so it is in range, does not split a surrogate pair, and always advances
 * for non-empty input (a leading delimiter such as `\n` would otherwise yield an empty accept).
 */
function safeBoundary(text: string, raw: number): number {
	let end = Math.max(0, Math.min(raw, text.length));
	if (end > 0 && end < text.length) {
		if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
		else if (isLowSurrogate(text.charCodeAt(end))) end += 1;
	}
	if (end <= 0 && text.length > 0) end = Math.min(codePointWidth(text, 0), text.length);
	return end;
}

/** Split a suggestion at the next boundary of the requested granularity. */
export function sliceForAccept(text: string, granularity: AcceptGranularity): AcceptSlice {
	if (text.length === 0) return { accepted: '', remaining: '' };
	const end = safeBoundary(text, rawBoundary(text, granularity));
	return { accepted: text.slice(0, end), remaining: text.slice(end) };
}

/**
 * Insert the accepted part of `suggestion` at its anchor and move the cursor after it.
 * Returns the text that is still unaccepted, for the controller to re-render as ghost text.
 */
export function applyAccept(
	view: EditorView,
	suggestion: ActiveSuggestion,
	granularity: AcceptGranularity | 'all',
): AcceptResult {
	const text = suggestion.remainingText;
	if (text.length === 0) return { accepted: '', remaining: null };

	const slice: AcceptSlice =
		granularity === 'all'
			? { accepted: text, remaining: '' }
			: sliceForAccept(text, granularity);
	if (slice.accepted.length === 0) return { accepted: '', remaining: text };

	const anchor = Math.max(0, Math.min(suggestion.anchor, view.state.doc.length));
	const accepted = slice.accepted;
	try {
		view.dispatch({
			changes: { from: anchor, to: anchor, insert: accepted },
			selection: { anchor: anchor + accepted.length },
			userEvent: 'input.predictive-accept',
			scrollIntoView: true,
		});
	} catch {
		// A destroyed view must not crash a command; report nothing accepted.
		return { accepted: '', remaining: text };
	}
	return { accepted, remaining: slice.remaining.length > 0 ? slice.remaining : null };
}
