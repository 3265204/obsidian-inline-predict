import { describe, expect, it } from 'vitest';
import { findReusableActive, findReusableCached } from '../../src/scheduler/reuse';
import type { ActiveSuggestion, CompletionCandidate, EditorSnapshot } from '../../src/core/types';

function snapshot(prefix: string, options: { cursor?: number; docId?: string } = {}): EditorSnapshot {
	const prefixOffset = 0;
	const cursor = options.cursor ?? prefix.length;
	return {
		docId: options.docId ?? 'notes/test.md',
		docVersion: 1,
		cursor,
		selectionFrom: cursor,
		selectionTo: cursor,
		prefix,
		prefixOffset,
		suffix: '',
		line: 0,
		ch: cursor,
		lineTextBefore: prefix,
		lineTextAfter: '',
		isComposing: false,
		timestamp: 0,
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

function candidate(text: string, anchor: number, overrides: Partial<CompletionCandidate> = {}): CompletionCandidate {
	return {
		requestId: 7,
		text,
		docId: 'notes/test.md',
		docVersion: 1,
		anchor,
		finishReason: 'stop',
		usage: null,
		modelId: 'fake',
		createdAt: 0,
		latencyMs: 5,
		source: 'model',
		degraded: false,
		reuseContext: { prefix: ({ 3: 'Hi ', 4: 'Hi  ', 6: 'Hello ' } as Record<number, string>)[anchor] ?? '', prefixOffset: 0, suffix: '' },
		...overrides,
	};
}

function active(text: string, anchor: number, overrides: Partial<ActiveSuggestion> = {}): ActiveSuggestion {
	return {
		candidate: candidate(text, anchor),
		remainingText: text,
		anchor,
		docVersion: 1,
		reusedFromRequestId: null,
		...overrides,
	};
}

describe('findReusableActive', () => {
	it('连续输入和相同光标更新都只返回尚未输入的余文', () => {
		const value = active('hello world', 3);
		const first = findReusableActive(value, snapshot('Hi hello '));
		expect(first?.remaining).toBe('world');
		const shifted = { ...value, anchor: 9, remainingText: 'world', docVersion: 2 };
		expect(findReusableActive(shifted, snapshot('Hi hello '))?.remaining).toBe('world');
		expect(findReusableActive(shifted, snapshot('Hi hello w'))?.remaining).toBe('orld');
		const second = { ...shifted, anchor: 10, remainingText: 'orld', docVersion: 3 };
		expect(findReusableActive(second, snapshot('Hi hello wo'))?.remaining).toBe('rld');
	});

	it('已接受区域被替换时不再复用原始候选', () => {
		const shifted = active('hello world', 3, { anchor: 9, remainingText: 'world' });
		expect(findReusableActive(shifted, snapshot('Hi other '))).toBeNull();
	});
	it('returns the whole candidate when nothing was typed', () => {
		const result = findReusableActive(active('hello world', 3), snapshot('Hi ', { cursor: 3 }));
		expect(result).toEqual({ remaining: 'hello world', anchor: 3 });
	});

	it('returns the remainder after a typed prefix', () => {
		const result = findReusableActive(active('hello world', 3), snapshot('Hi hello ', { cursor: 9 }));
		expect(result).toEqual({ remaining: 'world', anchor: 9 });
	});

	it('supports multiline candidates and typed newlines', () => {
		const candidateText = 'first line\nsecond line';
		const result = findReusableActive(
			active(candidateText, 0),
			snapshot('first line\n', { cursor: 11 }),
		);
		expect(result?.remaining).toBe('second line');
	});

	it('returns null when typed characters diverge', () => {
		expect(findReusableActive(active('hello', 0), snapshot('help'))).toBeNull();
	});

	it('returns null when the cursor is before the anchor', () => {
		const doc = snapshot('Hi ', { cursor: 1 });
		expect(findReusableActive(active('hello', 3), doc)).toBeNull();
	});

	it('returns null for a different document', () => {
		const doc = snapshot('Hi hello', { docId: 'other.md' });
		expect(findReusableActive(active('hello world', 3), doc)).toBeNull();
	});

	it('returns null once the candidate is fully typed', () => {
		expect(findReusableActive(active('hello', 0), snapshot('hello'))).toBeNull();
	});

	it('returns null when the anchor is outside the captured prefix window', () => {
		const doc = snapshot('hello', { cursor: 5 });
		doc.prefixOffset = 10;
		doc.prefix = '';
		doc.cursor = 15;
		expect(findReusableActive(active('hello', 0), doc)).toBeNull();
	});

	it('does not split surrogate pairs', () => {
		expect(findReusableActive(active('👋hi', 0), snapshot('👋'))?.remaining).toBe('hi');
		// A lone high surrogate at the end of the typed text cannot be matched safely.
		expect(findReusableActive(active('hi', 0), snapshot('\uD83D'))).toBeNull();
	});
});

describe('findReusableCached', () => {
	it('前文同长度替换、后文改变或缺少上下文元数据时拒绝缓存', () => {
		const value = candidate('world peace', 6);
		expect(findReusableCached([value], snapshot('Other '))).toBeNull();
		expect(findReusableCached([value], { ...snapshot('Hello '), suffix: 'new ending' })).toBeNull();
		expect(findReusableCached([{ ...value, reuseContext: undefined }], snapshot('Hello '))).toBeNull();
	});

	it('捕获窗口随连续输入前移时仍校验重叠区域', () => {
		const value = candidate('world peace', 6);
		const moved = { ...snapshot('lo world'), prefixOffset: 3, cursor: 11 };
		expect(findReusableCached([value], moved)?.remaining).toBe(' peace');
		expect(findReusableCached([value], { ...moved, prefix: 'xx world' })).toBeNull();
	});
	it('finds a matching cached candidate and reports the cursor anchor', () => {
		const entries = [candidate('world peace', 6)];
		const result = findReusableCached(entries, snapshot('Hello world', { cursor: 11 }));
		expect(result?.candidate).toBe(entries[0]);
		expect(result?.remaining).toBe(' peace');
		expect(result?.anchor).toBe(11);
	});

	it('returns the full text when the cursor still sits at the anchor', () => {
		const entries = [candidate('continuation', 4)];
		const result = findReusableCached(entries, snapshot('Hi  ', { cursor: 4 }));
		expect(result?.remaining).toBe('continuation');
	});

	it('skips candidates from another document or anchor', () => {
		const entries = [candidate('nope', 0, { docId: 'other.md' }), candidate('later', 10)];
		expect(findReusableCached(entries, snapshot('Hi ', { cursor: 3 }))).toBeNull();
	});

	it('skips candidates that no longer match the typed text', () => {
		expect(findReusableCached([candidate('hello', 0)], snapshot('help'))).toBeNull();
	});

	it('skips fully typed and empty candidates', () => {
		expect(findReusableCached([candidate('hello', 0)], snapshot('hello'))).toBeNull();
		expect(findReusableCached([candidate('', 0)], snapshot(''))).toBeNull();
	});

	it('returns the first match in the provided order', () => {
		const first = candidate('older match', 0);
		const second = candidate('newer match', 0);
		const result = findReusableCached([first, second], snapshot(''));
		expect(result?.candidate).toBe(first);
	});

	it('returns null for no entries', () => {
		expect(findReusableCached([], snapshot('Hi '))).toBeNull();
	});

	it('does not split surrogate pairs at the typed boundary', () => {
		expect(findReusableCached([candidate('👋hi', 0)], snapshot('👋'))?.remaining).toBe('hi');
		expect(findReusableCached([candidate('hi', 0)], snapshot('\uD83D'))).toBeNull();
	});
});
