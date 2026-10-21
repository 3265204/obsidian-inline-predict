import { Notice, Setting } from 'obsidian';
import { t } from '../../i18n';
import type { SettingsSectionContext } from './host';
import { addNote, addNumber, addSlider, addText, applyPatch, errorMessage } from './shared';

export function renderModelSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const { provider } = host.getSettings();


	addText(containerEl, {
		name: 'settings.model.baseUrl.name',
		desc: 'settings.model.baseUrl.desc',
		value: provider.baseUrl,
		placeholder: 'https://api.openai.com/v1',
		onChange: (value) => applyPatch(ctx, { provider: { baseUrl: value } }),
	});

	addText(containerEl, {
		name: 'settings.model.apiKey.name',
		desc: 'settings.model.apiKey.desc',
		value: provider.apiKey,
		secret: true,
		onChange: (value) => applyPatch(ctx, { provider: { apiKey: value } }),
	});

	addText(containerEl, {
		name: 'settings.model.modelId.name',
		desc: 'settings.model.modelId.desc',
		value: provider.modelId,
		placeholder: 'deepseek-flash',
		onChange: (value) => applyPatch(ctx, { provider: { modelId: value } }),
	});

	addNote(containerEl, t('settings.model.privacyNote'));

	const testConnection = host.testConnection?.bind(host);
	const testSetting = new Setting(containerEl)
		.setName(t('settings.model.test'))
		.setClass('predictive-model-test');

	testSetting.addButton((button) => {
		button.setButtonText(t('settings.model.test'));
		if (!testConnection) {
			// No host implementation in this build: show the affordance as disabled rather than
			// firing a network request from the settings UI.
			button.setDisabled(true);
			addNote(containerEl, t('settings.model.testUnavailable'));
			return;
		}
		button.onClick(async () => {
			button.setDisabled(true);
			try {
				const result = await testConnection();
				new Notice(
					result.ok
						? t('settings.model.testSuccess', { latency: result.message })
						: t('settings.model.testFailure', { message: result.message }),
				);
			} catch (error) {
				new Notice(t('settings.model.testFailure', { message: errorMessage(error) }));
			} finally {
				button.setDisabled(false);
			}
		});
	});

	const generation = containerEl;

	addSlider(generation, {
		name: 'settings.model.temperature.name',
		desc: 'settings.model.temperature.desc',
		value: provider.temperature,
		min: 0,
		max: 2,
		step: 0.05,
		onChange: (value) => applyPatch(ctx, { provider: { temperature: value } }),
	});

	addNumber(generation, {
		name: 'settings.model.maxOutputTokens.name',
		desc: 'settings.model.maxOutputTokens.desc',
		value: provider.maxOutputTokens,
		min: 16,
		max: 8192,
		step: 1,
		onChange: (value) => applyPatch(ctx, { provider: { maxOutputTokens: value } }),
	});

	addNumber(generation, {
		name: 'settings.model.timeout.name',
		desc: 'settings.model.timeout.desc',
		value: provider.timeoutMs,
		min: 500,
		max: 120000,
		step: 100,
		onChange: (value) => applyPatch(ctx, { provider: { timeoutMs: value } }),
	});

	addNumber(generation, {
		name: 'settings.model.contextWindow.name',
		desc: 'settings.model.contextWindow.desc',
		value: provider.contextWindow,
		min: 0,
		max: 2_000_000,
		step: 1000,
		onChange: (value) => applyPatch(ctx, { provider: { contextWindow: value } }),
	});

	new Setting(generation)
		.setName(t('settings.model.reasoningEffort.name'))
		.setDesc(t('settings.model.reasoningEffort.desc'))
		.addDropdown((dropdown) => {
			dropdown
				.addOption('', t('settings.model.reasoningEffort.default'))
				.addOption('none', 'none')
				.addOption('low', 'low')
				.addOption('medium', 'medium')
				.addOption('high', 'high')
				.setValue(provider.reasoningEffort)
				.onChange((value) => applyPatch(ctx, { provider: { reasoningEffort: value } }));
		});
}
