/** 普通笔记与临时缓冲区共享可配置的自动触发门槛。 */

import { describe, expect, it } from 'vitest';
import type { EditorSnapshot } from '../../src/core/types';
import {
	hasSufficientContext,
	shouldDeferAutoRequest,
} from '../../src/completion/context-gate';
import { DEFAULT_SETTINGS } from '../../src/settings/schema';

function snapshot(prefix: string, docId: string): EditorSnapshot {
	return {
		docId,
		docVersion: 1,
		cursor: prefix.length,
		selectionFrom: prefix.length,
		selectionTo: prefix.length,
		prefix,
		prefixOffset: 0,
		suffix: '',
		line: prefix.split('\n').length - 1,
		ch: prefix.length,
		lineTextBefore: prefix,
		lineTextAfter: '',
		isComposing: false,
		timestamp: Date.now(),
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

const untitled = '';
const settings = DEFAULT_SETTINGS.completion;

describe('context sufficiency', () => {
	it.each(['', 'notes/test.md'])('两个字符即可通过门槛，不需要标点或额外字数：%j', (docId) => {
		expect(settings.minPrefixChars).toBe(2);
		expect(shouldDeferAutoRequest(snapshot('线', docId), settings)).toBe(true);
		expect(shouldDeferAutoRequest(snapshot('线性', docId), settings)).toBe(false);
		expect(shouldDeferAutoRequest(snapshot('かな', docId), settings)).toBe(false);
	});

	it('用户调整的更高门槛仍然有效', () => {
		const custom = { ...settings, minPrefixChars: 8 };
		expect(shouldDeferAutoRequest(snapshot('线性', untitled), custom)).toBe(true);
	});
	it('临时缓冲区少于两个字符时等待', () => {
		expect(hasSufficientContext(snapshot('线', untitled), settings)).toBe(false);
		expect(shouldDeferAutoRequest(snapshot('线', untitled), settings)).toBe(true);
	});

	it('accepts an untitled buffer once a sentence is complete', () => {
		expect(hasSufficientContext(snapshot('特征值描述了线性变换的缩放比例。', untitled), settings)).toBe(true);
		expect(shouldDeferAutoRequest(snapshot('特征值描述了线性变换的缩放比例。', untitled), settings)).toBe(false);
	});

	it('accepts a long untitled paragraph without punctuation', () => {
		const long = '这是一段已经足够长的上下文用来预测接下来的一句话';
		expect(hasSufficientContext(snapshot(long, untitled), settings)).toBe(true);
	});

	it('does not defer for named notes (scheduler applies minPrefixChars)', () => {
		expect(shouldDeferAutoRequest(snapshot('线性代数', 'notes/linear.md'), settings)).toBe(false);
	});

	it('respects the auto-trigger switch', () => {
		const manual = { ...settings, autoTrigger: false };
		expect(shouldDeferAutoRequest(snapshot('线性代数', untitled), manual)).toBe(false);
	});
});
