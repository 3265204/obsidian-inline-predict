/**
 * Token budget manager.
 *
 * The budget is the contract between the context engine and the model: it says how many input
 * tokens may be spent and how that total is split between sections. Allocation is deterministic
 * (no dependency on the order sections happen to be produced in) and priority ordered, so that
 * when a document is too large the *least* valuable sections are dropped first.
 *
 * Counting is done with the injected `TokenCounter`, never with `ContextSection.estimatedTokens`
 * from the producer, so truncation decisions and the final report always agree with each other.
 */

import type {
	ContextSection,
	ContextSectionId,
	TokenBudget,
	TokenBudgetReport,
	TokenCounter,
} from '../core/types';
import { isHighSurrogate, isLowSurrogate } from '../core/text';

/**
 * Fixed prompt overhead that is not part of any section: section delimiters, wrapper tags and
 * the "continue the text" instruction. Kept small and explicit so the budget report can explain
 * where window tokens went.
 */
export const FIXED_PROMPT_OVERHEAD_TOKENS = 64;

/** Extra headroom so provider-side framing/rounding cannot push us past the window. */
export const BUDGET_SAFETY_MARGIN_TOKENS = 16;

/**
 * Section priority, highest first. Trimming always happens from the end of this list; within a
 * section the allocation is the hard ceiling.
 */
export const SECTION_PRIORITY: readonly ContextSectionId[] = [
	'rules',
	'before',
	'after',
	'structure',
	'knowledge',
	'profile',
	'recent-edits',
];

/**
 * Default split of the input budget. Weights sum to 1.0; the largest-remainder pass in
 * `createTokenBudget` makes the floors deterministic.
 */
const SECTION_WEIGHTS: Readonly<Record<ContextSectionId, number>> = {
	rules: 0.1,
	before: 0.32,
	after: 0.14,
	structure: 0.12,
	knowledge: 0.2,
	profile: 0.07,
	'recent-edits': 0.05,
};

function allocationRecord(fill: number): Record<ContextSectionId, number> {
	return {
		rules: fill,
		before: fill,
		after: fill,
		structure: fill,
		knowledge: fill,
		profile: fill,
		'recent-edits': fill,
	};
}

function priorityIndex(id: ContextSectionId): number {
	const index = SECTION_PRIORITY.indexOf(id);
	return index === -1 ? SECTION_PRIORITY.length : index;
}

/**
 * Split `inputTokens` into per-section ceilings. Uses floor + largest-remainder so the
 * allocations always sum exactly to `inputTokens` and are independent of call order.
 */
function allocateSections(inputTokens: number): Readonly<Record<ContextSectionId, number>> {
	const allocations = allocationRecord(0);
	if (inputTokens <= 0) return allocations;
	let assigned = 0;
	for (const id of SECTION_PRIORITY) {
		const ceiling = Math.floor(inputTokens * SECTION_WEIGHTS[id]);
		allocations[id] = ceiling;
		assigned += ceiling;
	}
	let remainder = inputTokens - assigned;
	// Money left over from flooring goes to earlier (higher-priority) sections first.
	for (const id of SECTION_PRIORITY) {
		if (remainder <= 0) break;
		allocations[id] += 1;
		remainder--;
	}
	return allocations;
}

/**
 * Create a budget for one request. `inputTokens` excludes the reserved output space and the
 * fixed prompt overhead; a too-small window degrades to a zero input budget rather than a
 * negative number.
 */
export function createTokenBudget(input: {
	contextWindow: number;
	reservedOutputTokens: number;
	promptOverheadTokens?: number;
}): TokenBudget {
	const windowTokens = Math.max(0, Math.floor(input.contextWindow));
	const reservedOutputTokens = Math.min(
		windowTokens,
		Math.max(0, Math.floor(input.reservedOutputTokens)),
	);
	const overhead = Math.min(
		(input.promptOverheadTokens ?? FIXED_PROMPT_OVERHEAD_TOKENS) + BUDGET_SAFETY_MARGIN_TOKENS,
		windowTokens - reservedOutputTokens,
	);
	const inputTokens = Math.max(0, windowTokens - reservedOutputTokens - overhead);
	return {
		windowTokens,
		reservedOutputTokens,
		inputTokens,
		allocations: allocateSections(inputTokens),
	};
}

/** Slice helper that never splits a surrogate pair. */
function safeSlice(text: string, length: number, keep: 'head' | 'tail'): string {
	if (length <= 0) return '';
	if (length >= text.length) return text;
	if (keep === 'head') {
		let end = length;
		if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end--;
		return text.slice(0, end);
	}
	let start = text.length - length;
	if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start++;
	return text.slice(start);
}

/**
 * Truncate `text` to at most `maxTokens` counted tokens.
 *
 * `keep: 'head'` keeps the beginning (rules, the text after the cursor); `keep: 'tail'` keeps the
 * end (the text before the cursor, where the continuation is most relevant). Never returns half
 * a surrogate pair and never exceeds `maxTokens` when the counter is monotone (the final loop is
 * a safety net for counters that are not).
 */
export function truncateTextToTokens(
	text: string,
	maxTokens: number,
	counter: TokenCounter,
	keep: 'head' | 'tail',
): string {
	if (maxTokens <= 0 || text.length === 0) return '';
	if (counter.count(text) <= maxTokens) return text;

	// Binary search the largest code-unit length that still fits.
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (counter.count(safeSlice(text, mid, keep)) <= maxTokens) low = mid;
		else high = mid - 1;
	}

	let candidate = safeSlice(text, low, keep);
	while (candidate.length > 0 && counter.count(candidate) > maxTokens) {
		candidate = safeSlice(candidate, candidate.length - 1, keep);
	}
	return candidate;
}

/**
 * Fit assembled sections into a budget: order by priority, clamp each section to its allocation
 * (and to what is left), truncate, and report what was used and what was dropped. The returned
 * sections are copies; the input is never mutated.
 */
export function fitSectionsToBudget(
	sections: readonly ContextSection[],
	budget: TokenBudget,
	counter: TokenCounter,
): { sections: ContextSection[]; report: TokenBudgetReport } {
	const ordered = [...sections].sort(
		(a, b) => priorityIndex(a.id) - priorityIndex(b.id),
	);
	const usedBySection = allocationRecord(0);
	const omitted: ContextSectionId[] = [];
	const kept: ContextSection[] = [];
	let remaining = Math.max(0, budget.inputTokens);

	for (const section of ordered) {
		const allocation = Math.max(0, budget.allocations[section.id] - usedBySection[section.id]);
		const allowance = Math.min(allocation, remaining);
		if (allowance <= 0) {
			omitted.push(section.id);
			continue;
		}
		const originalCount = counter.count(section.text);
		if (section.text.length === 0 || originalCount === 0) {
			omitted.push(section.id);
			continue;
		}
		let text = section.text;
		let count = originalCount;
		let truncated = false;
		if (originalCount > allowance) {
			// Keep the part closest to the cursor: the tail of `before`, the head of everything else.
			text = truncateTextToTokens(
				section.text,
				allowance,
				counter,
				section.id === 'before' ? 'tail' : 'head',
			);
			count = text.length === 0 ? 0 : counter.count(text);
			truncated = true;
			if (count === 0 || count > allowance) {
				omitted.push(section.id);
				continue;
			}
		}
		remaining -= count;
		usedBySection[section.id] += count;
		kept.push({
			id: section.id,
			label: section.label,
			trust: section.trust,
			text,
			estimatedTokens: count,
			...(truncated ? { truncated: true } : {}),
		});
	}

	const totalInputTokens = SECTION_PRIORITY.reduce(
		(total, id) => total + usedBySection[id],
		0,
	);
	return {
		sections: kept,
		report: {
			budget,
			usedBySection,
			omitted,
			totalInputTokens,
		},
	};
}
