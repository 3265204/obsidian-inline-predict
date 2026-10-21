import { describe, expect, it } from 'vitest';
import {
	codePointLength,
	sanitizeControlCharacters,
	commonPrefixLength,
	endsWithHighSurrogate,
	lastCompleteBoundary,
	matchTypedPrefix,
	nextLineEnd,
	nextParagraphEnd,
	nextSentenceEnd,
	nextWordEnd,
	segmentGraphemes,
	trailingWhitespaceLength,
} from '../../src/core/text';

describe('unicode basics', () => {
	it('counts code points, not UTF-16 units', () => {
		expect(codePointLength('abc')).toBe(3);
		expect(codePointLength('特征值')).toBe(3);
		expect(codePointLength('a😀b')).toBe(3);
	});

	it('detects lone high surrogates', () => {
		expect(endsWithHighSurrogate('\uD83D')).toBe(true);
		expect(endsWithHighSurrogate('😀')).toBe(false);
		expect(endsWithHighSurrogate('abc')).toBe(false);
	});

	it('never splits a surrogate pair when computing common prefixes', () => {
		// Same high surrogate, different low surrogate: the pair must not be split.
		expect(commonPrefixLength('😀x', '😁x')).toBe(0);
		expect(commonPrefixLength('😀x', '😀y')).toBe(2);
		expect(commonPrefixLength('abc', 'ab')).toBe(2);
	});
});

describe('matchTypedPrefix (incremental completion)', () => {
	const candidate = '特征值描述了线性变换在特征向量方向上的缩放比例。';

	it('returns the candidate when nothing has been typed yet', () => {
		expect(matchTypedPrefix(candidate, '')).toBe(candidate);
	});

	it('returns only the remainder when the user typed a prefix', () => {
		expect(matchTypedPrefix(candidate, '特征值描述了')).toBe(
			'线性变换在特征向量方向上的缩放比例。',
		);
	});

	it('returns null on mismatch', () => {
		expect(matchTypedPrefix(candidate, '特征值说明')).toBeNull();
	});

	it('returns null when typed text is longer than the candidate', () => {
		expect(matchTypedPrefix('abc', 'abcd')).toBeNull();
	});

	it('rejects a typed prefix that ends mid-surrogate-pair', () => {
		expect(matchTypedPrefix('😀abc', '\uD83D')).toBeNull();
		expect(matchTypedPrefix('😀abc', '😀')).toBe('abc');
	});

	it('handles newlines and CRLF-ish prefixes', () => {
		const multi = '第一行\n\n- 列表项';
		expect(matchTypedPrefix(multi, '第一行\n\n')).toBe('- 列表项');
		expect(matchTypedPrefix(multi, '第一行\n-')).toBeNull();
	});
});

describe('segmentation', () => {
	it('keeps combining marks attached', () => {
		expect(segmentGraphemes('e\u0301x')).toEqual(['e\u0301', 'x']);
	});

	it('keeps emoji with variation selectors/ZWJ intact when supported', () => {
		const graphemes = segmentGraphemes('👨‍👩‍👧a');
		expect(graphemes[graphemes.length - 1]).toBe('a');
		expect(graphemes.join('')).toBe('👨‍👩‍👧a');
	});
});

describe('accept boundaries', () => {
	it('word: latin run plus trailing space', () => {
		expect(nextWordEnd('hello world')).toBe(6);
		expect(nextWordEnd('hello')).toBe(5);
	});

	it('word: CJK advances one character', () => {
		expect(nextWordEnd('特征值')).toBe(1);
	});

	it('word: leading punctuation is consumed alone', () => {
		expect(nextWordEnd('，你好')).toBe(1);
	});

	it('sentence: consumes terminators and following space', () => {
		expect(nextSentenceEnd('你好。世界')).toBe(3);
		expect(nextSentenceEnd('Hi. There')).toBe(4);
		expect(nextSentenceEnd('Wait?! Really')).toBe(7);
	});

	it('sentence: no terminator returns whole text', () => {
		expect(nextSentenceEnd('no punctuation here')).toBe('no punctuation here'.length);
	});

	it('line and paragraph boundaries', () => {
		expect(nextLineEnd('first\nsecond')).toBe(5);
		expect(nextLineEnd('single')).toBe(6);
		expect(nextParagraphEnd('para one\n\npara two')).toBe(8);
		expect(nextParagraphEnd('one line')).toBe(8);
	});
});

describe('truncation repair', () => {
	it('finds the last sentence boundary', () => {
		expect(lastCompleteBoundary('特征值描述了缩放。下一句未完成', 1)).toBe(9);
	});

	it('falls back to the last newline', () => {
		expect(lastCompleteBoundary('first line\nsecond line partial', 1)).toBe(10);
	});

	it('ignores boundaries that are too early', () => {
		expect(lastCompleteBoundary('a. then a very long unfinished tail', 10)).toBe(-1);
	});
});

describe('whitespace helpers', () => {
	it('counts trailing whitespace', () => {
		expect(trailingWhitespaceLength('abc  \n')).toBe(3);
		expect(trailingWhitespaceLength('abc')).toBe(0);
	});
});


describe('控制字符清理', () => {
	const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('') + String.fromCharCode(127);
	it('正文保留制表换行和完整 Unicode 文本', () => {
		expect(sanitizeControlCharacters('中文😀' + controls + 'かな')).toBe('中文😀\t\n\rかな');
	});
	it('错误信息中的全部控制字符替换为空格', () => {
		expect(sanitizeControlCharacters(controls, false, ' ')).toBe(' '.repeat(33));
	});
});
