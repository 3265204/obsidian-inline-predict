import { ButtonComponent } from 'obsidian';

import { t } from '../../i18n';
import type { SettingsSectionContext } from './host';
import { addNote, addToggle, applyPatch } from './shared';

/**
 * M6 is not shipped in this build, so the profile actions are rendered disabled: no fake
 * progress, no placeholder data and no "success" notice for work that did not happen. The
 * settings toggle is real and persists `learning.enabled` (default off). Actions are collapsed
 * because they are unavailable; the toggle and explanation stay visible.
 *
 * When M6 lands, enable these buttons and wire them to `host.exportProfile/importProfile/
 * clearProfile` (and a future scan/cancel capability).
 */
const PROFILE_ACTIONS_AVAILABLE: boolean = false;

export function renderLearningSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const { learning } = host.getSettings();


	addToggle(containerEl, {
		name: 'settings.learning.enabled.name',
		desc: 'settings.learning.enabled.desc',
		value: learning.enabled,
		onChange: (value) => applyPatch(ctx, { learning: { enabled: value } }),
	});

	// Honest note about what the profile is (and is not) until profile APIs ship.
	addNote(containerEl, t('settings.learning.mergedNote'));

	const actions = containerEl;

	const row = actions.createDiv({ cls: 'predictive-button-row' });
	const buttons: Array<{ label: string; destructive?: boolean }> = [
		{ label: t('settings.learning.scan') },
		{ label: t('settings.learning.cancel') },
		{ label: t('settings.learning.export') },
		{ label: t('settings.learning.import') },
		{ label: t('settings.learning.clear'), destructive: true },
	];

	for (const action of buttons) {
		const button = new ButtonComponent(row);
		button.setButtonText(action.label);
		if (action.destructive) button.setWarning();
		if (!PROFILE_ACTIONS_AVAILABLE) {
			// Enabled together with the M6 implementation; until then the disabled state is the
			// honest signal that clicking would not do anything.
			button.setDisabled(true);
		}
	}

	if (!PROFILE_ACTIONS_AVAILABLE) {
		addNote(actions, t('settings.learning.notAvailable'));
	}
}
