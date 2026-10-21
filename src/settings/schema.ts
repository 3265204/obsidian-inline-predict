/**
 * Settings contract. The UI, scheduler, model adapter and future retrieval engine all read
 * from this shape; nothing else may define duplicated defaults.
 *
 * Privacy defaults are deliberate: semantic retrieval, remote embedding and writing-profile
 * learning are OFF until the user turns them on. The plugin never makes a network call merely
 * because it was installed.
 */

export const SETTINGS_SCHEMA_VERSION = 1;

export interface ModelProviderSettings {
	/** OpenAI-compatible base URL, without a trailing slash. */
	baseUrl: string;
	apiKey: string;
	modelId: string;
	temperature: number;
	/** Hard safety cap for output tokens. Not a target length. */
	maxOutputTokens: number;
	timeoutMs: number;
	/** 0 = use the adapter's declared context window. */
	contextWindow: number;
	/**
	 * Optional provider parameter (`reasoning_effort`); empty means "omit entirely".
	 * Reasoning models such as DeepSeek V4 Flash spend hidden reasoning tokens by default,
	 * which is unacceptable for inline prediction latency and can consume the whole output
	 * budget. `none` disables that path.
	 */
	reasoningEffort: string;
}

export interface CompletionSettings {
	enabled: boolean;
	autoTrigger: boolean;
	/** Base debounce before a prediction request, tuned adaptively by the scheduler. */
	baseDebounceMs: number;
	/** Do not predict until there is this much prefix text (avoids noise on blank files). */
	minPrefixChars: number;
	/** Safety net against runaway generations; the validator also enforces semantic stopping. */
	maxSuggestionChars: number;
	/**
	 * Local relatedness filter: reject long suggestions sharing no term with a short CJK context.
	 * Zero extra network cost; see `src/prediction/relatedness.ts`.
	 */
	filterOffTopic: boolean;
	/**
	 * Ask the completion model a tiny YES/NO relevance question for candidates the local filter
	 * finds suspicious. Adds one small request only in those rare cases.
	 */
	verifyOffTopicWithModel: boolean;
}

export interface EmbeddingSettings {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	batchSize: number;
}

export interface SemanticSettings {
	enabled: boolean;
	embedding: EmbeddingSettings;
}

export interface LearningSettings {
	/** Persist and update a local writing profile. Off by default. */
	enabled: boolean;
}

export interface PrivacySettings {
	/** Explicit consent to send cursor-adjacent note text to the configured model provider. */
	remoteContextConsent: boolean;
	/** Explicit consent to upload note chunks to the configured embedding provider (M5). */
	remoteEmbeddingConsent: boolean;
}

export interface AdvancedSettings {
	/** L1 prediction cache entries. */
	cacheEntries: number;
	/** L2 warm-context cache entries. */
	contextCacheEntries: number;
	/** Verbose local logging for debugging; never sends anything anywhere. */
	debugLogging: boolean;
}

export interface PredictiveSettings {
	schemaVersion: number;
	completion: CompletionSettings;
	provider: ModelProviderSettings;
	semantic: SemanticSettings;
	learning: LearningSettings;
	privacy: PrivacySettings;
	advanced: AdvancedSettings;
}

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_SETTINGS: PredictiveSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	completion: {
		enabled: true,
		autoTrigger: true,
		baseDebounceMs: 400,
		minPrefixChars: 2,
		maxSuggestionChars: 4000,
		filterOffTopic: true,
		verifyOffTopicWithModel: true,
	},
	provider: {
		baseUrl: 'https://api.openai.com/v1',
		apiKey: '',
		modelId: 'gpt-4o-mini',
		temperature: 0.2,
		maxOutputTokens: 256,
		timeoutMs: 8000,
		contextWindow: 0,
		reasoningEffort: '',
	},
	semantic: {
		enabled: false,
		embedding: {
			baseUrl: 'https://api.openai.com/v1',
			apiKey: '',
			modelId: 'text-embedding-3-small',
			batchSize: 32,
		},
	},
	learning: {
		enabled: false,
	},
	privacy: {
		remoteContextConsent: false,
		remoteEmbeddingConsent: false,
	},
	advanced: {
		cacheEntries: 64,
		contextCacheEntries: 32,
		debugLogging: false,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function obj(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/**
 * Coerce persisted/untrusted data into a valid settings object. Unknown keys are dropped,
 * out-of-range numbers are clamped, and missing values fall back to defaults. Never throws.
 */
export function normalizeSettings(raw: unknown): PredictiveSettings {
	const root = obj(raw);
	const provider = obj(root.provider);
	const completion = obj(root.completion);
	const semantic = obj(root.semantic);
	const embedding = obj(semantic.embedding);
	const learning = obj(root.learning);
	const privacy = obj(root.privacy);
	const advanced = obj(root.advanced);
	const d = DEFAULT_SETTINGS;

	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		completion: {
			enabled: bool(completion.enabled, d.completion.enabled),
			autoTrigger: bool(completion.autoTrigger, d.completion.autoTrigger),
			baseDebounceMs: num(completion.baseDebounceMs, d.completion.baseDebounceMs, 0, 5000),
			minPrefixChars: num(completion.minPrefixChars, d.completion.minPrefixChars, 0, 200),
			maxSuggestionChars: num(
				completion.maxSuggestionChars,
				d.completion.maxSuggestionChars,
				80,
				20000,
			),
			filterOffTopic: bool(completion.filterOffTopic, d.completion.filterOffTopic),
			verifyOffTopicWithModel: bool(
				completion.verifyOffTopicWithModel,
				d.completion.verifyOffTopicWithModel,
			),
		},
		provider: {
			baseUrl: str(provider.baseUrl, d.provider.baseUrl).trim(),
			apiKey: str(provider.apiKey, d.provider.apiKey),
			modelId: str(provider.modelId, d.provider.modelId).trim(),
			temperature: num(provider.temperature, d.provider.temperature, 0, 2),
			maxOutputTokens: num(provider.maxOutputTokens, d.provider.maxOutputTokens, 16, 8192),
			timeoutMs: num(provider.timeoutMs, d.provider.timeoutMs, 500, 120000),
			contextWindow: num(provider.contextWindow, d.provider.contextWindow, 0, 2_000_000),
			reasoningEffort: str(provider.reasoningEffort, d.provider.reasoningEffort).trim(),
		},
		semantic: {
			enabled: bool(semantic.enabled, d.semantic.enabled),
			embedding: {
				baseUrl: str(embedding.baseUrl, d.semantic.embedding.baseUrl).trim(),
				apiKey: str(embedding.apiKey, d.semantic.embedding.apiKey),
				modelId: str(embedding.modelId, d.semantic.embedding.modelId).trim(),
				batchSize: num(embedding.batchSize, d.semantic.embedding.batchSize, 1, 256),
			},
		},
		learning: {
			enabled: bool(learning.enabled, d.learning.enabled),
		},
		privacy: {
			remoteContextConsent: bool(privacy.remoteContextConsent, d.privacy.remoteContextConsent),
			remoteEmbeddingConsent: bool(
				privacy.remoteEmbeddingConsent,
				d.privacy.remoteEmbeddingConsent,
			),
		},
		advanced: {
			cacheEntries: num(advanced.cacheEntries, d.advanced.cacheEntries, 1, 512),
			contextCacheEntries: num(
				advanced.contextCacheEntries,
				d.advanced.contextCacheEntries,
				1,
				256,
			),
			debugLogging: bool(advanced.debugLogging, d.advanced.debugLogging),
		},
	};
}

/** Merge a patch into settings without mutating either input. Re-normalized afterwards. */
export function applySettingsPatch(
	base: PredictiveSettings,
	patch: DeepPartial<PredictiveSettings>,
): PredictiveSettings {
	const merge = (a: unknown, b: unknown): unknown => {
		if (!isRecord(a) || !isRecord(b)) return b === undefined ? a : b;
		const out: Record<string, unknown> = { ...a };
		for (const [key, value] of Object.entries(b)) {
			if (value === undefined) continue;
			out[key] = isRecord(value) ? merge(out[key], value) : value;
		}
		return out;
	};
	return normalizeSettings(merge(base, patch));
}

/** Model id is required for completion; without it we must not call any provider. */
export function isCompletionConfigured(settings: PredictiveSettings): boolean {
	return settings.provider.modelId.trim().length > 0;
}

/** An embedding backend is only "available" with explicit opt-in and a model id. */
export function isEmbeddingConfigured(settings: PredictiveSettings): boolean {
	return (
		settings.semantic.enabled &&
		settings.semantic.embedding.modelId.trim().length > 0 &&
		settings.privacy.remoteEmbeddingConsent
	);
}
