/** 在原始上下文未改变且新增文本与候选匹配时复用建议，避免额外模型调用。 */

import type { ActiveSuggestion, CompletionCandidate, EditorSnapshot } from '../core/types';
import { matchTypedPrefix } from '../core/text';

/** Characters typed between `anchor` and the cursor, or null when that span is not in the snapshot. */
function typedSince(snapshot: EditorSnapshot, anchor: number): string | null {
	if (anchor < snapshot.prefixOffset) return null;
	const end = snapshot.prefixOffset + snapshot.prefix.length;
	if (snapshot.cursor < anchor || snapshot.cursor > end) return null;
	return snapshot.prefix.slice(anchor - snapshot.prefixOffset, snapshot.cursor - snapshot.prefixOffset);
}

/** A fully typed candidate has no remainder left to show. */
function isUsableRemainder(remaining: string): boolean {
	return remaining.length > 0;
}

/** 仅允许保留原始上下文、连续插入候选前缀的修改。 */
function contextMatches(candidate: CompletionCandidate, snapshot: EditorSnapshot): boolean {
	const context = candidate.reuseContext;
	if (!context || context.suffix !== snapshot.suffix) return false;
	if (candidate.anchor < snapshot.prefixOffset) return false;
	const overlapStart = Math.max(context.prefixOffset, snapshot.prefixOffset);
	if (overlapStart > candidate.anchor) return false;
	return snapshot.prefix.slice(overlapStart - snapshot.prefixOffset, candidate.anchor - snapshot.prefixOffset) ===
		context.prefix.slice(overlapStart - context.prefixOffset);
}

export interface ActiveReuseResult {
	remaining: string;
	/** Absolute offset where the remainder starts (always the current cursor). */
	anchor: number;
}

/**
 * Reuse the suggestion currently on screen when every character typed since its anchor still
 * matches the candidate. Returns null on mismatch, a different document, or a cursor before the
 * anchor (undo/backspace past the insertion point).
 */
export function findReusableActive(
	active: ActiveSuggestion,
	snapshot: EditorSnapshot,
): ActiveReuseResult | null {
	if (active.candidate.docId !== snapshot.docId) return null;
	if (!contextMatches(active.candidate, snapshot)) return null;
	if (snapshot.cursor < active.anchor) return null;
	const typed = typedSince(snapshot, active.anchor);
	if (typed === null) return null;
	const remaining = matchTypedPrefix(active.remainingText, typed);
	if (remaining === null || !isUsableRemainder(remaining)) return null;
	const originalTyped = typedSince(snapshot, active.candidate.anchor);
	if (originalTyped === null || matchTypedPrefix(active.candidate.text, originalTyped) !== remaining) return null;
	return { remaining, anchor: snapshot.cursor };
}

export interface CachedReuseResult {
	candidate: CompletionCandidate;
	remaining: string;
	anchor: number;
}

/**
 * Find a cached candidate whose text still matches what the user typed since its own anchor.
 * `entries` order defines preference (callers pass newest-first).
 */
export function findReusableCached(
	entries: readonly CompletionCandidate[],
	snapshot: EditorSnapshot,
): CachedReuseResult | null {
	for (const candidate of entries) {
		if (candidate.docId !== snapshot.docId) continue;
		if (!contextMatches(candidate, snapshot)) continue;
		if (candidate.text.length === 0) continue;
		if (candidate.anchor > snapshot.cursor) continue;
		const typed = typedSince(snapshot, candidate.anchor);
		if (typed === null) continue;
		const remaining = matchTypedPrefix(candidate.text, typed);
		if (remaining === null || !isUsableRemainder(remaining)) continue;
		return { candidate, remaining, anchor: snapshot.cursor };
	}
	return null;
}
