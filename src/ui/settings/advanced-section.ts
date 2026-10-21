import { Setting } from 'obsidian';
import { t } from '../../i18n';
import { DEFAULT_SETTINGS } from '../../settings/schema';
import type { SettingsSectionContext } from './host';
import { addNumber, addToggle, applyPatch, confirmAction } from './shared';

/**
 * Advanced options live in a collapsed group (same visual language as the other secondary
 * groups) so they never compete with the main workflow.
 */
export function renderAdvancedSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const { advanced } = host.getSettings();

	const body = containerEl;

	addNumber(body, {
		name: 'settings.advanced.cacheEntries.name',
		desc: 'settings.advanced.cacheEntries.desc',
		value: advanced.cacheEntries,
		min: 1,
		max: 512,
		step: 1,
		onChange: (value) => applyPatch(ctx, { advanced: { cacheEntries: value } }),
	});

	addNumber(body, {
		name: 'settings.advanced.contextEntries.name',
		desc: 'settings.advanced.contextEntries.desc',
		value: advanced.contextCacheEntries,
		min: 1,
		max: 256,
		step: 1,
		onChange: (value) => applyPatch(ctx, { advanced: { contextCacheEntries: value } }),
	});

	addToggle(body, {
		name: 'settings.advanced.debug.name',
		desc: 'settings.advanced.debug.desc',
		value: advanced.debugLogging,
		onChange: (value) => applyPatch(ctx, { advanced: { debugLogging: value } }),
	});

	new Setting(body)
		.setName(t('settings.advanced.resetAll'))
		.addButton((button) => {
			button.setButtonText(t('settings.advanced.resetAll'));
			button.setWarning();
			button.onClick(() => {
				confirmAction(ctx, {
					title: t('settings.advanced.resetAll'),
					message: t('settings.advanced.resetConfirm'),
					confirmLabel: t('settings.advanced.resetAll'),
					onConfirm: () => {
						void (async () => {
							// DEFAULT_SETTINGS is a full document; `updateSettings` normalizes it like
							// any other patch, so this resets every section in one write.
							await host.updateSettings({ ...DEFAULT_SETTINGS });
							ctx.refresh();
						})();
					},
				});
			});
		});
}
