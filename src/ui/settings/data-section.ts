import { Notice, Setting } from 'obsidian';
import { t } from '../../i18n';
import type { SettingsSectionContext } from './host';
import { addNote, confirmAction, errorMessage, notifyError } from './shared';

/** Index & cache actions share the "long-running, may call the host" shape. */
export function renderDataSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;


	addNote(containerEl, t('settings.data.storageNote'));

	const actions = containerEl;

	const rebuildSetting = new Setting(actions)
		.setName(t('settings.data.rebuildIndex'))
		.setDesc(t('settings.data.rebuildIndex.desc'));

	rebuildSetting.addButton((button) => {
		button.setButtonText(t('settings.data.rebuildIndex'));
		button.setCta();
		button.onClick(async () => {
			button.setDisabled(true);
			try {
				await host.rebuildIndex();
				new Notice(t('notice.indexRebuilt'));
			} catch (error) {
				notifyError(error);
			} finally {
				button.setDisabled(false);
			}
		});
	});

	new Setting(actions)
		.setName(t('settings.data.clearCache'))
		.setDesc(t('settings.data.clearCache.desc'))
		.addButton((button) => {
			button.setButtonText(t('settings.data.clearCache'));
			button.onClick(() => {
				confirmAction(ctx, {
					title: t('settings.data.clearCache'),
					message: t('settings.data.clearCache.desc'),
					confirmLabel: t('settings.data.clearCache'),
					onConfirm: () => {
						void (async () => {
							try {
								await host.clearCaches();
								new Notice(t('notice.cacheCleared'));
							} catch (error) {
								new Notice(
									t('notice.requestFailed', { message: errorMessage(error) }),
								);
							}
						})();
					},
				});
			});
		});
}
