/**
 * Model control-token leakage.
 *
 * DeepSeek V4 occasionally emits internal DSML tool-call markup (e.g. `</｜｜DSML｜｜ parameter>`)
 * as ordinary content instead of parsing it as a tool call. Such fragments must never reach the
 * editor: they are stripped before validation, and a response consisting only of markup is
 * rejected as empty.
 */

import { describe, expect, it } from 'vitest';
import type { EditorSnapshot } from '../../src/core/types';
import { stripModelControlTokens } from '../../src/core/text';
import { validateSuggestion } from '../../src/prediction/validator';

function snapshot(prefix: string, suffix = ''): EditorSnapshot {
	return {
		docId: 'note.md',
		docVersion: 1,
		cursor: prefix.length,
		selectionFrom: prefix.length,
		selectionTo: prefix.length,
		prefix,
		prefixOffset: 0,
		suffix,
		line: 0,
		ch: prefix.length,
		lineTextBefore: prefix,
		lineTextAfter: suffix,
		isComposing: false,
		timestamp: Date.now(),
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'live',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

function response(text: string) {
	return {
		text,
		finishReason: 'stop' as const,
		usage: null,
		modelId: 'deepseek-flash',
	};
}

describe('stripModelControlTokens', () => {
	it('removes leaked DSML parameter markup', () => {
		expect(stripModelControlTokens('特征值与特征向量的关系</｜｜DSML｜｜ parameter>')).toBe(
			'特征值与特征向量的关系',
		);
	});

	it('removes DSML invoke blocks and ASCII special tokens', () => {
		expect(stripModelControlTokens('answer<｜｜DSML｜｜invoke name="search">x</｜｜DSML｜｜invoke>')).toBe(
			'answerx',
		);
		expect(stripModelControlTokens('done<|endoftext|>')).toBe('done');
	});

	it('removes bare DSML markers without angle brackets', () => {
		expect(stripModelControlTokens('结论：成立 ｜｜DSML｜｜parameter>')).toBe('结论：成立 ');
	});

	it('keeps ordinary Markdown, HTML and math untouched', () => {
		const text = '设 $x < y$，见 <b>定义</b> 与 `<code>`。';
		expect(stripModelControlTokens(text)).toBe(text);
	});
});

describe('validator strips leaked markup', () => {
	it('shows the clean insertion text', () => {
		const result = validateSuggestion({
			response: response('矩阵相似的性质</｜｜DSML｜｜ parameter>'),
			snapshot: snapshot('- 第二项：'),
			maxChars: 4_000,
		});
		expect(result.rejected).toBeNull();
		expect(result.text).toBe('矩阵相似的性质');
	});

	it('rejects a response that is only markup', () => {
		const result = validateSuggestion({
			response: response('</｜｜DSML｜｜ parameter>'),
			snapshot: snapshot('- 第二项：'),
			maxChars: 4_000,
		});
		expect(result.text).toBeNull();
		expect(result.rejected).toBe('empty');
	});
});
