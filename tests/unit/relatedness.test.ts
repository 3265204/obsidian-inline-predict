/**
 * Local relatedness filter: a long suggestion that shares no term at all with a short Chinese
 * context is unrelated memorized text, not a prediction. The unrelated-text example is the
 * regression that motivated this check.
 */

import { describe, expect, it } from 'vitest';
import type { EditorSnapshot } from '../../src/core/types';
import { assessOffTopic } from '../../src/prediction/relatedness';
import { validateSuggestion } from '../../src/prediction/validator';

const UNRELATED_TEXT =
	'清晨的海边十分安静，渔船缓缓驶离港口，远处的灯塔在薄雾中若隐若现。';

function snapshot(prefix: string): EditorSnapshot {
	return {
		docId: '',
		docVersion: 1,
		cursor: prefix.length,
		selectionFrom: prefix.length,
		selectionTo: prefix.length,
		prefix,
		prefixOffset: 0,
		suffix: '',
		line: 0,
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

function response(text: string) {
	return { text, finishReason: 'stop' as const, usage: null, modelId: 'deepseek-flash' };
}

describe('assessOffTopic', () => {
	it('flags the unrelated boilerplate after 线性代数', () => {
		const result = assessOffTopic('线性代数', UNRELATED_TEXT);
		expect(result.assessed).toBe(true);
		expect(result.offTopic).toBe(true);
		expect(result.score).toBe(0);
	});

	it('accepts a related long continuation', () => {
		const result = assessOffTopic('线性代数', '是研究向量空间与线性变换的数学分支，广泛应用于物理与工程。');
		expect(result.assessed).toBe(true);
		expect(result.offTopic).toBe(false);
		expect(result.score).toBeGreaterThan(0);
	});

	it('never flags short continuations', () => {
		expect(assessOffTopic('线性代数', '的').assessed).toBe(false);
		expect(assessOffTopic('线性代数', '的定义如下。').assessed).toBe(false);
	});

	it('does not assess non-Chinese or long contexts', () => {
		expect(assessOffTopic('The linear', ' algebra course covers matrices.').assessed).toBe(false);
		expect(assessOffTopic('字'.repeat(200), UNRELATED_TEXT).assessed).toBe(false);
	});

	it('accepts a related same-domain long suggestion after 特征值', () => {
		const result = assessOffTopic('特征值', '与特征向量描述了线性变换在特定方向上的缩放比例。');
		expect(result.offTopic).toBe(false);
	});
});

describe('validator relatedness gate', () => {
	it('rejects off-topic text when the filter is enabled', () => {
		const result = validateSuggestion({
			response: response(UNRELATED_TEXT),
			snapshot: snapshot('线性代数'),
			maxChars: 4_000,
			offTopicFilter: true,
		});
		// The cleaned text is preserved so the prediction engine can ask the model judge.
		expect(result.text).toBe(UNRELATED_TEXT);
		expect(result.rejected).toBe('off-topic');
	});

	it('keeps the same text when the filter is disabled', () => {
		const result = validateSuggestion({
			response: response(UNRELATED_TEXT),
			snapshot: snapshot('线性代数'),
			maxChars: 4_000,
			offTopicFilter: false,
		});
		expect(result.rejected).toBeNull();
		expect(result.text).toBe(UNRELATED_TEXT);
	});
});
