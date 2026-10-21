import { en } from './en';
import { zhCn } from './zh-cn';

export type Locale = 'en' | 'zh-cn';
export type TranslationKey = keyof typeof en;
export type TranslationParams = Readonly<Record<string, string | number>>;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
	en,
	'zh-cn': zhCn,
};

let currentLocale: Locale = 'en';

/**
 * Obsidian exposes its UI language through `moment.locale()` (e.g. `zh-cn`, `en-gb`).
 * Anything Chinese becomes `zh-cn`; everything else falls back to English.
 */
export function detectLocale(rawLocale: string | undefined | null): Locale {
	const normalized = (rawLocale ?? '').toLowerCase();
	if (normalized.startsWith('zh')) return 'zh-cn';
	return 'en';
}

export function setLocale(locale: string | undefined | null): void {
	currentLocale = detectLocale(locale);
}

/**
 * Pick the first usable locale signal. Obsidian's official `getLanguage()` (app setting) must win
 * over `moment.locale()` and `navigator.language`, otherwise a user who set the app UI to English
 * on a Chinese OS would see plugin strings in Chinese (or vice versa).
 */
export function resolveLocale(sources: readonly (string | null | undefined)[]): Locale {
	for (const source of sources) {
		const normalized = source?.trim();
		if (normalized && normalized.length > 0) return detectLocale(normalized);
	}
	return 'en';
}

export function getLocale(): Locale {
	return currentLocale;
}

export function interpolate(template: string, params: TranslationParams = {}): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = params[key];
		return value === undefined ? match : String(value);
	});
}

/** Translate a key for an explicit locale; falls back to English, then to the key itself. */
export function translate(locale: Locale, key: TranslationKey, params?: TranslationParams): string {
	const template = dictionaries[locale][key] ?? en[key] ?? key;
	return interpolate(template, params);
}

/** Translate a key with the currently active locale. */
export function t(key: TranslationKey, params?: TranslationParams): string {
	return translate(currentLocale, key, params);
}
