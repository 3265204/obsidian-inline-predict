import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en';
import { zhCn } from '../../src/i18n/zh-cn';
import {
	detectLocale,
	getLocale,
	resolveLocale,
	interpolate,
	setLocale,
	t,
	translate,
	type TranslationKey,
} from '../../src/i18n';

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zhCn).sort();

/** Placeholder names used by a template, sorted, e.g. `'{count} of {total}'` → `['count','total']`. */
function placeholders(template: string): string[] {
	return [...template.matchAll(/\{(\w+)\}/g)]
		.map((match) => match[1] ?? '')
		.sort();
}

beforeEach(() => {
	setLocale('en');
});

afterEach(() => {
	setLocale('en');
});

describe('dictionary parity', () => {
	it('en and zh-cn define exactly the same keys', () => {
		expect(zhKeys).toEqual(enKeys);
	});

	it('has no empty translations', () => {
		for (const key of enKeys) {
			const typedKey = key as TranslationKey;
			expect(en[typedKey].length, `en:${key}`).toBeGreaterThan(0);
			expect(zhCn[typedKey].length, `zh-cn:${key}`).toBeGreaterThan(0);
		}
	});

	it('keeps interpolation placeholders identical across locales', () => {
		for (const key of enKeys) {
			const typedKey = key as TranslationKey;
			expect(placeholders(zhCn[typedKey]), `zh-cn:${key}`).toEqual(
				placeholders(en[typedKey]),
			);
		}
	});
});

describe('interpolation', () => {
	it('replaces named placeholders', () => {
		expect(interpolate('{count} results in {folder}', { count: 3, folder: 'notes' })).toBe(
			'3 results in notes',
		);
	});

	it('leaves unknown placeholders untouched', () => {
		expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
	});

	it('translates with parameters in the active locale', () => {
		expect(t('search.results', { count: 2 })).toBe('2 results');

		setLocale('zh-cn');
		expect(t('search.results', { count: 2 })).toBe('2 条结果');
	});

	it('translates for an explicit locale', () => {
		expect(translate('zh-cn', 'notice.statsReset')).toBe('预测统计已重置。');
		expect(translate('en', 'notice.statsReset')).toBe('Prediction statistics reset.');
	});

	it('falls back to the key itself for unknown keys', () => {
		const unknown = 'this.key.does.not.exist' as TranslationKey;
		expect(translate('en', unknown)).toBe('this.key.does.not.exist');
		expect(translate('zh-cn', unknown)).toBe('this.key.does.not.exist');
	});
});

describe('locale detection', () => {
	it('maps Chinese locales to zh-cn', () => {
		expect(detectLocale('zh-cn')).toBe('zh-cn');
		expect(detectLocale('zh')).toBe('zh-cn');
		expect(detectLocale('ZH-TW')).toBe('zh-cn');
	});

	it('maps everything else to en', () => {
		expect(detectLocale('en-gb')).toBe('en');
		expect(detectLocale('fr')).toBe('en');
		expect(detectLocale(undefined)).toBe('en');
		expect(detectLocale(null)).toBe('en');
	});

	it('updates the active locale used by t()', () => {
		setLocale('zh');
		expect(getLocale()).toBe('zh-cn');
		expect(t('status.disabled')).toBe(zhCn['status.disabled']);

		setLocale('en-gb');
		expect(getLocale()).toBe('en');
		expect(t('status.disabled')).toBe(en['status.disabled']);
	});
});

describe('resolveLocale', () => {
	it('uses the first non-empty signal (app language first)', () => {
		expect(resolveLocale(['zh', 'en'])).toBe('zh-cn');
		expect(resolveLocale(['en', 'zh-cn'])).toBe('en');
		expect(resolveLocale([undefined, '', 'zh-CN'])).toBe('zh-cn');
		expect(resolveLocale([])).toBe('en');
	});
});
