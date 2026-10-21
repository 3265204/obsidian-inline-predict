import { describe, expect, it } from 'vitest';
import type { EditorSnapshot, ModelResponse } from '../../src/core/types';
import { validateSuggestion } from '../../src/prediction/validator';

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
	return {
		docId: 'Notes/test.md',
		docVersion: 1,
		cursor: 0,
		selectionFrom: 0,
		selectionTo: 0,
		prefix: '',
		prefixOffset: 0,
		suffix: '',
		line: 0,
		ch: 0,
		lineTextBefore: '',
		lineTextAfter: '',
		isComposing: false,
		timestamp: 0,
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
		...overrides,
	};
}

function makeResponse(
	text: string,
	finishReason: ModelResponse['finishReason'] = 'stop',
): ModelResponse {
	return { text, finishReason, usage: null, modelId: 'test-model' };
}

describe('validateSuggestion', () => {
	it('returns clean text and trims trailing whitespace', () => {
		const result = validateSuggestion({
			response: makeResponse(' new completion text  \n'),
			snapshot: makeSnapshot({ prefix: 'Hello world' }),
			maxChars: 1_000,
		});
		expect(result.text).toBe(' new completion text');
		expect(result.rejected).toBeNull();
		expect(result.degraded).toBe(false);
	});

	it('rejects empty and whitespace-only responses', () => {
		for (const text of ['', '   ', '\n\n\t ']) {
			const result = validateSuggestion({
				response: makeResponse(text),
				snapshot: makeSnapshot(),
				maxChars: 1_000,
			});
			expect(result.text).toBeNull();
			expect(result.rejected).toBe('empty');
		}
	});

	it('normalizes CRLF to LF', () => {
		const result = validateSuggestion({
			response: makeResponse('line one\r\nline two'),
			snapshot: makeSnapshot(),
			maxChars: 1_000,
		});
		expect(result.text).toBe('line one\nline two');
	});

	it('rejects content_filter, error and unknown finish reasons', () => {
		const base = { snapshot: makeSnapshot(), maxChars: 1_000 };
		expect(
			validateSuggestion({ ...base, response: makeResponse('text', 'content_filter') }).rejected,
		).toBe('validator-rejected');
		expect(validateSuggestion({ ...base, response: makeResponse('text', 'tool_calls') }).rejected).toBe(
			'validator-rejected',
		);
		expect(validateSuggestion({ ...base, response: makeResponse('text', 'error') }).rejected).toBe(
			'error',
		);
		expect(validateSuggestion({ ...base, response: makeResponse('text', 'unknown') }).rejected).toBe(
			'validator-rejected',
		);
	});

	it('repairs length-truncated output at the last complete boundary', () => {
		const text = 'This is a complete sentence. And a second sentence that got cut';
		const result = validateSuggestion({
			response: makeResponse(text, 'length'),
			snapshot: makeSnapshot(),
			maxChars: 1_000,
		});
		expect(result.rejected).toBeNull();
		expect(result.degraded).toBe(true);
		expect(result.text).toBe('This is a complete sentence.');
	});

	it('rejects length-truncated output without a usable boundary', () => {
		const result = validateSuggestion({
			response: makeResponse('a fragment without any end punctuation that was cut', 'length'),
			snapshot: makeSnapshot(),
			maxChars: 1_000,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('truncated');
		expect(result.degraded).toBe(true);
	});

	it('rejects length-truncated output that would lose too much text', () => {
		// Boundary exists but keeps only a tiny prefix of a long answer.
		const result = validateSuggestion({
			response: makeResponse(`Hi. ${'x'.repeat(200)}`, 'length'),
			snapshot: makeSnapshot(),
			maxChars: 1_000,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('truncated');
	});

	it('truncates over-limit output at a natural boundary and degrades it', () => {
		const result = validateSuggestion({
			response: makeResponse('First sentence. Second sentence. Third sentence.'),
			snapshot: makeSnapshot(),
			maxChars: 20,
		});
		expect(result.text).toBe('First sentence.');
		expect(result.rejected).toBeNull();
		expect(result.degraded).toBe(true);
	});

	it('rejects when the character cap leaves too little text', () => {
		const result = validateSuggestion({
			response: makeResponse('A much longer completion than allowed'),
			snapshot: makeSnapshot(),
			maxChars: 5,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('truncated');
		expect(result.degraded).toBe(true);
	});

	it('rejects candidates that echo the following text', () => {
		const result = validateSuggestion({
			response: makeResponse('the lazy dog.'),
			snapshot: makeSnapshot({ prefix: 'The quick brown fox ', suffix: 'the lazy dog.' }),
			maxChars: 1_000,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('echo');
	});

	it('rejects a multi-line candidate whose first line echoes the suffix', () => {
		const result = validateSuggestion({
			response: makeResponse('the lazy dog.\nmore text'),
			snapshot: makeSnapshot({ suffix: 'the lazy dog.\nand then...' }),
			maxChars: 1_000,
		});
		expect(result.rejected).toBe('echo');
	});

	it('rejects candidates that repeat the text before the cursor', () => {
		const result = validateSuggestion({
			response: makeResponse('quick brown fox'),
			snapshot: makeSnapshot({ prefix: 'The quick brown fox' }),
			maxChars: 1_000,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('echo');
	});

	it('strips an accidental wrapping fence outside code blocks', () => {
		const result = validateSuggestion({
			response: makeResponse('```markdown\nSome wrapped text here.\n```'),
			snapshot: makeSnapshot({ prefix: 'Intro. ' }),
			maxChars: 1_000,
		});
		expect(result.text).toBe('Some wrapped text here.');
		expect(result.rejected).toBeNull();
		expect(result.degraded).toBe(false);
	});

	it('keeps fences when the cursor is inside a code block', () => {
		const result = validateSuggestion({
			response: makeResponse('```js\nconst answer = 42;\n```'),
			snapshot: makeSnapshot({ prefix: '```js\n', inCodeBlock: true }),
			maxChars: 1_000,
		});
		expect(result.text).toBe('```js\nconst answer = 42;\n```');
		expect(result.rejected).toBeNull();
	});

	it('drops a trailing high surrogate instead of corrupting the document', () => {
		const result = validateSuggestion({
			response: makeResponse(`hello ${String.fromCharCode(0xd83d)}`),
			snapshot: makeSnapshot(),
			maxChars: 1_000,
		});
		expect(result.text).toBe('hello');
	});
});
