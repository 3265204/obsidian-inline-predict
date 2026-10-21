import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import PredictivePlugin from '../../src/main';
import { DEFAULT_SETTINGS, applySettingsPatch, type DeepPartial, type PredictiveSettings } from '../../src/settings/schema';
import { predictionRuntimeChanged } from '../../src/settings/runtime';
import { LruPredictionCache } from '../../src/scheduler/prediction-cache';

describe('运行配置更新', () => {
	it.each([
		{ provider: { reasoningEffort: 'none' } },
		{ provider: { modelId: 'another-model' } },
		{ completion: { filterOffTopic: false } },
		{ completion: { verifyOffTopicWithModel: false } },
	] satisfies DeepPartial<PredictiveSettings>[])('修改构造参数后重建实例并失效缓存：%j', async (patch) => {
		const plugin = new PredictivePlugin({} as App, {
			id: 'inline-predict', name: 'Inline Predict', version: '0.1.0', minAppVersion: '1.5.0', author: 'test', description: 'test',
		});
		plugin.settings = applySettingsPatch(DEFAULT_SETTINGS, { provider: { apiKey: 'test-key' } });
		const probe = plugin as unknown as {
			cache: LruPredictionCache;
			configurationVersion: number;
			updateSettings(patch: DeepPartial<PredictiveSettings>): Promise<void>;
			rebuildPredictionStack(): void;
		};
		probe.cache = new LruPredictionCache();
		const clear = vi.spyOn(probe.cache, 'clear');
		const rebuild = vi.spyOn(probe, 'rebuildPredictionStack').mockImplementation(() => undefined);
		await probe.updateSettings(patch);
		expect(rebuild).toHaveBeenCalledOnce();
		expect(clear).toHaveBeenCalledOnce();
		expect(probe.configurationVersion).toBe(1);
	});

	it('只修改输入等待时间不重建模型', () => {
		const next = applySettingsPatch(DEFAULT_SETTINGS, { completion: { baseDebounceMs: 900 } });
		expect(predictionRuntimeChanged(DEFAULT_SETTINGS, next)).toBe(false);
	});
});
