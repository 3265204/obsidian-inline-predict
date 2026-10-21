import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SETTINGS,
	SETTINGS_SCHEMA_VERSION,
	applySettingsPatch,
	isCompletionConfigured,
	isEmbeddingConfigured,
	normalizeSettings,
} from '../../src/settings/schema';
import type { PredictiveSettings } from '../../src/settings/schema';

/** Deep copy so a mutation of DEFAULT_SETTINGS would be visible but not corrupt later tests. */
function snapshot(value: PredictiveSettings): PredictiveSettings {
	return JSON.parse(JSON.stringify(value)) as PredictiveSettings;
}

describe('normalizeSettings defaults', () => {
	it('returns the shipped defaults for missing input', () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
	});

	it('returns the shipped defaults for non-object input', () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps privacy-sensitive features off by default', () => {
		const settings = normalizeSettings(undefined);
		expect(settings.semantic.enabled).toBe(false);
		expect(settings.privacy.remoteEmbeddingConsent).toBe(false);
		expect(settings.learning.enabled).toBe(false);
		expect(settings.privacy.remoteContextConsent).toBe(false);
	});

	it('forces the current schema version', () => {
		expect(normalizeSettings({ schemaVersion: 999 }).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		expect(SETTINGS_SCHEMA_VERSION).toBe(1);
	});

	it('drops unknown keys', () => {
		const settings = normalizeSettings({
			bogus: true,
			completion: { enabled: false, bogus: 'x' },
			provider: { modelId: 'my-model', bogus: 7 },
		});
		expect(settings).not.toHaveProperty('bogus');
		expect(settings.completion).not.toHaveProperty('bogus');
		expect(settings.provider).not.toHaveProperty('bogus');
		expect(settings.provider.modelId).toBe('my-model');
	});

	it('trims configured URLs and model ids', () => {
		const settings = normalizeSettings({
			provider: { baseUrl: '  https://example.test/v1  ', modelId: '  model-x  ' },
			semantic: { embedding: { modelId: '  embed-x  ' } },
		});
		expect(settings.provider.baseUrl).toBe('https://example.test/v1');
		expect(settings.provider.modelId).toBe('model-x');
		expect(settings.semantic.embedding.modelId).toBe('embed-x');
	});
});

describe('normalizeSettings clamping', () => {
	it('clamps out-of-range numbers instead of accepting them', () => {
		const settings = normalizeSettings({
			completion: { baseDebounceMs: -1, minPrefixChars: 999, maxSuggestionChars: 0 },
			provider: { temperature: 99, maxOutputTokens: 1, timeoutMs: 10, contextWindow: -5 },
			advanced: { cacheEntries: 0, contextCacheEntries: 10_000 },
		});

		expect(settings.completion.baseDebounceMs).toBe(0);
		expect(settings.completion.minPrefixChars).toBe(200);
		expect(settings.completion.maxSuggestionChars).toBe(80);
		expect(settings.provider.temperature).toBe(2);
		expect(settings.provider.maxOutputTokens).toBe(16);
		expect(settings.provider.timeoutMs).toBe(500);
		expect(settings.provider.contextWindow).toBe(0);
		expect(settings.advanced.cacheEntries).toBe(1);
		expect(settings.advanced.contextCacheEntries).toBe(256);
	});

	it('falls back to defaults for NaN and infinite numbers', () => {
		const settings = normalizeSettings({
			completion: { baseDebounceMs: Number.NaN },
			provider: { temperature: Number.POSITIVE_INFINITY },
		});
		expect(settings.completion.baseDebounceMs).toBe(DEFAULT_SETTINGS.completion.baseDebounceMs);
		expect(settings.provider.temperature).toBe(DEFAULT_SETTINGS.provider.temperature);
	});

	it('falls back to defaults for wrongly typed fields', () => {
		const settings = normalizeSettings({
			completion: { enabled: 'yes' },
			provider: { apiKey: 42 },
			privacy: { remoteContextConsent: 1 },
		});
		expect(settings.completion.enabled).toBe(DEFAULT_SETTINGS.completion.enabled);
		expect(settings.provider.apiKey).toBe(DEFAULT_SETTINGS.provider.apiKey);
		expect(settings.privacy.remoteContextConsent).toBe(false);
	});
});

describe('applySettingsPatch', () => {
	it('does not mutate the base settings', () => {
		const base = normalizeSettings(undefined);
		const before = snapshot(base);

		const patched = applySettingsPatch(base, {
			provider: { modelId: 'patched-model' },
			completion: { enabled: false },
		});

		expect(snapshot(base)).toEqual(before);
		expect(patched.provider.modelId).toBe('patched-model');
		expect(patched.completion.enabled).toBe(false);
	});

	it('deep-merges only the patched branches', () => {
		const base = normalizeSettings({
			provider: { baseUrl: 'https://base.test/v1', modelId: 'base-model', temperature: 0.5 },
		});

		const patched = applySettingsPatch(base, {
			provider: { modelId: 'new-model' },
		});

		expect(patched.provider.modelId).toBe('new-model');
		expect(patched.provider.baseUrl).toBe('https://base.test/v1');
		expect(patched.provider.temperature).toBe(0.5);
		expect(patched.completion).toEqual(base.completion);
	});

	it('re-normalizes patched values', () => {
		const base = normalizeSettings(undefined);

		const patched = applySettingsPatch(base, {
			provider: { temperature: 99 },
			completion: { baseDebounceMs: -20 },
		});

		expect(patched.provider.temperature).toBe(2);
		expect(patched.completion.baseDebounceMs).toBe(0);
	});

	it('ignores undefined patch values', () => {
		const base = normalizeSettings(undefined);

		const patched = applySettingsPatch(base, { provider: { apiKey: undefined } });

		expect(patched).toEqual(base);
	});
});

describe('capability checks', () => {
	it('requires a model id for completion', () => {
		expect(isCompletionConfigured(normalizeSettings(undefined))).toBe(true);
		expect(isCompletionConfigured(normalizeSettings({ provider: { modelId: '   ' } }))).toBe(
			false,
		);
	});

	it('requires opt-in, a model id and consent before embedding is configured', () => {
		const enabledModel = normalizeSettings({
			semantic: { enabled: true, embedding: { modelId: 'embed-x' } },
		});

		// Enabled and configured, but no consent: still not available.
		expect(enabledModel.semantic.enabled).toBe(true);
		expect(isEmbeddingConfigured(enabledModel)).toBe(false);

		const withConsent = applySettingsPatch(enabledModel, {
			privacy: { remoteEmbeddingConsent: true },
		});
		expect(isEmbeddingConfigured(withConsent)).toBe(true);

		const withoutModel = applySettingsPatch(withConsent, {
			semantic: { embedding: { modelId: '   ' } },
		});
		expect(isEmbeddingConfigured(withoutModel)).toBe(false);

		const disabled = applySettingsPatch(withConsent, { semantic: { enabled: false } });
		expect(isEmbeddingConfigured(disabled)).toBe(false);
	});
});
