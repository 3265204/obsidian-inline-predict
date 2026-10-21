import type { PredictiveSettings } from './schema';

/** 构造时读取的配置一旦变化，必须同时重建实例并失效旧候选。 */
export function predictionRuntimeChanged(previous: PredictiveSettings, next: PredictiveSettings): boolean {
	return (Object.keys(previous.provider) as (keyof PredictiveSettings['provider'])[])
		.some((key) => previous.provider[key] !== next.provider[key]) ||
		previous.completion.maxSuggestionChars !== next.completion.maxSuggestionChars ||
		previous.completion.filterOffTopic !== next.completion.filterOffTopic ||
		previous.completion.verifyOffTopicWithModel !== next.completion.verifyOffTopicWithModel ||
		previous.advanced.contextCacheEntries !== next.advanced.contextCacheEntries;
}
