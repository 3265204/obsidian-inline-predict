import { Setting } from 'obsidian';
import { t } from '../../i18n';
import type { SettingsSectionContext } from './host';
import { addNumber, addSlider, addToggle, applyPatch } from './shared';

/**
 * Completion settings.
 *
 * "Inline predictions" is the master switch: it persists in `data.json` and gates every other
 * completion option. "Predict automatically while typing" is subordinate — with it off, the ghost
 * only appears after the explicit "Predict now" command. Secondary tuning lives in collapsible
 * groups so the main workflow stays visible as new options are added.
 */
export function renderCompletionSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const { completion } = host.getSettings();
	const dependents: Setting[] = [];


	addToggle(containerEl, {
		name: 'settings.completion.enabled.name',
		desc: 'settings.completion.enabled.desc',
		value: completion.enabled,
		onChange: (value) => {
			for (const setting of dependents) setting.setDisabled(!value);
			void applyPatch(ctx, { completion: { enabled: value } });
		},
	});

	dependents.push(
		addToggle(containerEl, {
			name: 'settings.completion.autoTrigger.name',
			desc: 'settings.completion.autoTrigger.desc',
			value: completion.autoTrigger,
			onChange: (value) => applyPatch(ctx, { completion: { autoTrigger: value } }),
		}),
	);

	const triggering = containerEl;

	dependents.push(
		addSlider(triggering, {
			name: 'settings.completion.debounce.name',
			desc: 'settings.completion.debounce.desc',
			value: completion.baseDebounceMs,
			min: 0,
			max: 5000,
			step: 50,
			onChange: (value) => applyPatch(ctx, { completion: { baseDebounceMs: value } }),
		}),
	);
	dependents.push(
		addNumber(triggering, {
			name: 'settings.completion.minPrefix.name',
			desc: 'settings.completion.minPrefix.desc',
			value: completion.minPrefixChars,
			min: 0,
			max: 200,
			step: 1,
			onChange: (value) => applyPatch(ctx, { completion: { minPrefixChars: value } }),
		}),
	);
	dependents.push(
		addNumber(triggering, {
			name: 'settings.completion.maxChars.name',
			desc: 'settings.completion.maxChars.desc',
			value: completion.maxSuggestionChars,
			min: 80,
			max: 20000,
			step: 1,
			onChange: (value) => applyPatch(ctx, { completion: { maxSuggestionChars: value } }),
		}),
	);

	const quality = containerEl;

	dependents.push(
		addToggle(quality, {
			name: 'settings.completion.filterOffTopic.name',
			desc: 'settings.completion.filterOffTopic.desc',
			value: completion.filterOffTopic,
			onChange: (value) => applyPatch(ctx, { completion: { filterOffTopic: value } }),
		}),
	);
	dependents.push(
		addToggle(quality, {
			name: 'settings.completion.judge.name',
			desc: 'settings.completion.judge.desc',
			value: completion.verifyOffTopicWithModel,
			onChange: (value) => applyPatch(ctx, { completion: { verifyOffTopicWithModel: value } }),
		}),
	);

	if (!completion.enabled) {
		for (const setting of dependents) setting.setDisabled(true);
	}
}
