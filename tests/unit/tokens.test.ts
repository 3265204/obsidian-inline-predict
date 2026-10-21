import { describe, expect, it } from 'vitest';
import { HeuristicTokenCounter, estimateTokens } from '../../src/tokens/estimator';
import {
	BUDGET_SAFETY_MARGIN_TOKENS,
	FIXED_PROMPT_OVERHEAD_TOKENS,
	SECTION_PRIORITY,
	createTokenBudget,
	fitSectionsToBudget,
	truncateTextToTokens,
} from '../../src/tokens/budget';
import type { ContextSection, ContextSectionId, ContextTrust } from '../../src/core/types';
import { isHighSurrogate, isLowSurrogate } from '../../src/core/text';

const counter = new HeuristicTokenCounter();

function section(id: ContextSectionId, text: string): ContextSection {
	const trust: ContextTrust = id === 'rules' ? 'system' : id === 'knowledge' ? 'retrieved' : 'document';
	return { id, label: id, trust, text, estimatedTokens: 0 };
}

describe('estimateTokens', () => {
	it('returns 0 only for empty text', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens(' ')).toBe(1);
		expect(estimateTokens('.')).toBe(1);
	});

	it('uses ~4 characters per token for Latin text', () => {
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('hello')).toBe(2);
		expect(estimateTokens('hello world')).toBe(3);
		expect(estimateTokens('a'.repeat(400))).toBe(100);
	});

	it('counts CJK text at roughly one token per character', () => {
		expect(estimateTokens('你好世界')).toBe(4);
		expect(estimateTokens('こんにちは')).toBe(5);
		expect(estimateTokens('汉')).toBe(1);
	});

	it('mixes scripts additively', () => {
		// 5 Latin chars -> 2 tokens, 2 CJK chars -> 2 tokens
		expect(estimateTokens('hello你好')).toBe(4);
	});

	it('is conservative for non-CJK unicode code points', () => {
		expect(estimateTokens('😀')).toBe(2);
		expect(estimateTokens('😀😀')).toBe(4);
		expect(estimateTokens('Привет')).toBe(12); // six Cyrillic code points at 2 tokens each
	});

	it('is monotone for growing Latin text', () => {
		let previous = 0;
		for (let length = 1; length <= 64; length++) {
			const value = estimateTokens('a'.repeat(length));
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});
});

describe('HeuristicTokenCounter', () => {
	it('has a stable id and matches the free function', () => {
		expect(counter.id).toBe('heuristic-v1');
		expect(counter.count('hello')).toBe(estimateTokens('hello'));
	});

	it('adds chat framing overhead per message', () => {
		expect(counter.countMessages([])).toBe(0);
		const one = counter.countMessages([{ role: 'user', content: 'hi' }]);
		const two = counter.countMessages([
			{ role: 'system', content: 'hi' },
			{ role: 'user', content: 'hi' },
		]);
		expect(one).toBeGreaterThan(counter.count('hi'));
		expect(two).toBeGreaterThan(one);
	});
});

describe('createTokenBudget', () => {
	it('reserves output space and fixed prompt overhead', () => {
		const budget = createTokenBudget({ contextWindow: 8192, reservedOutputTokens: 256 });
		const overhead = FIXED_PROMPT_OVERHEAD_TOKENS + BUDGET_SAFETY_MARGIN_TOKENS;
		expect(budget.windowTokens).toBe(8192);
		expect(budget.reservedOutputTokens).toBe(256);
		expect(budget.inputTokens).toBe(8192 - 256 - overhead);
	});

	it('allocations are deterministic and sum to the input budget', () => {
		const a = createTokenBudget({ contextWindow: 8192, reservedOutputTokens: 256 });
		const b = createTokenBudget({ contextWindow: 8192, reservedOutputTokens: 256 });
		expect(a.allocations).toEqual(b.allocations);
		const sum = SECTION_PRIORITY.reduce((total, id) => total + a.allocations[id], 0);
		expect(sum).toBe(a.inputTokens);
		for (const id of SECTION_PRIORITY) expect(a.allocations[id]).toBeGreaterThanOrEqual(0);
	});

	it('clamps a too-small window to a zero input budget', () => {
		const budget = createTokenBudget({ contextWindow: 100, reservedOutputTokens: 90 });
		expect(budget.inputTokens).toBe(0);
		expect(budget.reservedOutputTokens).toBe(90);
		for (const id of SECTION_PRIORITY) expect(budget.allocations[id]).toBe(0);
	});

	it('clamps negative or oversized reservations', () => {
		const negative = createTokenBudget({ contextWindow: 1000, reservedOutputTokens: -50 });
		expect(negative.reservedOutputTokens).toBe(0);
		const oversized = createTokenBudget({ contextWindow: 1000, reservedOutputTokens: 5000 });
		expect(oversized.reservedOutputTokens).toBe(1000);
		expect(oversized.inputTokens).toBe(0);
	});
});

describe('truncateTextToTokens', () => {
	it('returns short text unchanged', () => {
		expect(truncateTextToTokens('hello', 100, counter, 'head')).toBe('hello');
	});

	it('returns an empty string for a zero budget', () => {
		expect(truncateTextToTokens('hello', 0, counter, 'head')).toBe('');
		expect(truncateTextToTokens('hello', 0, counter, 'tail')).toBe('');
	});

	it('keeps the head or the tail as requested', () => {
		const text = `${'x'.repeat(400)}MIDDLE${'y'.repeat(400)}`;
		const head = truncateTextToTokens(text, 10, counter, 'head');
		const tail = truncateTextToTokens(text, 10, counter, 'tail');
		expect(head.startsWith('xxxx')).toBe(true);
		expect(head.includes('MIDDLE')).toBe(false);
		expect(tail.endsWith('yyyy')).toBe(true);
		expect(tail.includes('MIDDLE')).toBe(false);
		expect(counter.count(head)).toBeLessThanOrEqual(10);
		expect(counter.count(tail)).toBeLessThanOrEqual(10);
	});

	it('never splits a surrogate pair', () => {
		const text = '😀😀😀';
		const head = truncateTextToTokens(text, 4, counter, 'head');
		const tail = truncateTextToTokens(text, 3, counter, 'tail');
		expect(counter.count(head)).toBeLessThanOrEqual(4);
		expect(counter.count(tail)).toBeLessThanOrEqual(3);
		for (const result of [head, tail]) {
			expect(result.length).toBeGreaterThan(0);
			const last = result.charCodeAt(result.length - 1);
			expect(isHighSurrogate(last)).toBe(false);
			expect(isLowSurrogate(result.charCodeAt(0))).toBe(false);
		}
	});
});

describe('fitSectionsToBudget', () => {
	it('never exceeds the budget and reports every section', () => {
		const budget = createTokenBudget({ contextWindow: 400, reservedOutputTokens: 100 });
		const sections = SECTION_PRIORITY.map((id) => section(id, 'a'.repeat(2000)));
		const result = fitSectionsToBudget(sections, budget, counter);
		expect(result.report.totalInputTokens).toBeLessThanOrEqual(budget.inputTokens);
		for (const id of SECTION_PRIORITY) {
			const used = result.report.usedBySection[id];
			expect(used).toBeLessThanOrEqual(budget.allocations[id]);
			expect(used).toBeGreaterThanOrEqual(0);
		}
		// Every section had a positive allocation, so with ASCII filler each is trimmed to exactly
		// its allocation and the totals match.
		expect(result.report.totalInputTokens).toBe(budget.inputTokens);
		expect(result.report.omitted).toEqual([]);
		expect(result.sections).toHaveLength(SECTION_PRIORITY.length);
		expect(result.sections.map((s) => s.id)).toEqual([...SECTION_PRIORITY]);
		for (const kept of result.sections) {
			expect(kept.truncated).toBe(true);
			expect(kept.estimatedTokens).toBe(result.report.usedBySection[kept.id]);
		}
	});

	it('trims by priority, dropping low-value sections first', () => {
		// inputTokens = 182 - 100 - 80 = 2; only rules and before get one token each.
		const budget = createTokenBudget({ contextWindow: 182, reservedOutputTokens: 100 });
		expect(budget.inputTokens).toBe(2);
		const sections = SECTION_PRIORITY.map((id) => section(id, 'value '.repeat(100)));
		const result = fitSectionsToBudget(sections, budget, counter);
		expect(result.sections.map((s) => s.id)).toEqual(['rules', 'before']);
		expect(result.report.omitted).toEqual(['after', 'structure', 'knowledge', 'profile', 'recent-edits']);
		expect(result.report.totalInputTokens).toBe(2);
	});

	it('drops empty sections and truncates before/after toward the cursor', () => {
		const budget = createTokenBudget({ contextWindow: 400, reservedOutputTokens: 100 });
		const before = section('before', `HEAD${'x'.repeat(2000)}ENDMARKER`);
		const after = section('after', `STARTMARKER${'y'.repeat(2000)}`);
		const result = fitSectionsToBudget(
			[section('rules', ''), before, after],
			budget,
			counter,
		);
		const byId = new Map(result.sections.map((s) => [s.id, s]));
		expect(byId.has('rules')).toBe(false);
		expect(result.report.omitted).toContain('rules');
		const keptBefore = byId.get('before');
		const keptAfter = byId.get('after');
		expect(keptBefore?.text.endsWith('ENDMARKER')).toBe(true);
		expect(keptBefore?.text.startsWith('HEAD')).toBe(false);
		expect(keptAfter?.text.startsWith('STARTMARKER')).toBe(true);
		expect(keptAfter?.text.length).toBeGreaterThan(0);
		for (const kept of result.sections) {
			expect(counter.count(kept.text)).toBeLessThanOrEqual(budget.allocations[kept.id]);
		}
	});

	it('does not mutate the input sections and is independent of input order', () => {
		const budget = createTokenBudget({ contextWindow: 400, reservedOutputTokens: 100 });
		const ordered = SECTION_PRIORITY.map((id) => section(id, `${id} `.repeat(200)));
		const shuffled = [...ordered].reverse();
		const first = fitSectionsToBudget(ordered, budget, counter);
		const second = fitSectionsToBudget(shuffled, budget, counter);
		expect(second.report).toEqual(first.report);
		expect(second.sections.map((s) => s.id)).toEqual(first.sections.map((s) => s.id));
		// Original estimatedTokens untouched.
		expect(ordered.every((s) => s.estimatedTokens === 0)).toBe(true);
	});

	it('handles CJK text without exceeding allocations', () => {
		const budget = createTokenBudget({ contextWindow: 300, reservedOutputTokens: 50 });
		const sections = SECTION_PRIORITY.map((id) => section(id, '这是一段用于测试的中文文本。'.repeat(50)));
		const result = fitSectionsToBudget(sections, budget, counter);
		expect(result.report.totalInputTokens).toBeLessThanOrEqual(budget.inputTokens);
		for (const kept of result.sections) {
			expect(counter.count(kept.text)).toBeLessThanOrEqual(budget.allocations[kept.id]);
		}
	});
});
