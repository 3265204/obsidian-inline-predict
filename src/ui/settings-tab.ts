/**
 * Inline Predict 设置页面。
 *
 * Every top-level category is one collapsible group containing *all* of its options — no mixed
 * states where part of a category is visible and part is hidden. The tab itself only owns the
 * group shell and ordering; section renderers fill the group body and never create headings.
 */

import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { t } from '../i18n';
import type { TranslationKey } from '../i18n';
import { addCollapsibleGroup } from './settings/collapsible';
import { renderAdvancedSection } from './settings/advanced-section';
import { renderCompletionSection } from './settings/completion-section';
import { renderDataSection } from './settings/data-section';
import { renderDiagnosticsSection } from './settings/diagnostics-section';
import { renderLearningSection } from './settings/learning-section';
import { renderModelSection } from './settings/model-section';
import { renderSemanticSection } from './settings/semantic-section';
import type { SettingsHost, SettingsSectionContext } from './settings/host';

export type { SettingsHost } from './settings/host';

interface SettingsCategory {
	title: TranslationKey;
	render: (ctx: SettingsSectionContext) => void;
}

/** Category order mirrors user priority: completion first, rarely touched options last. */
const CATEGORIES: readonly SettingsCategory[] = [
	{ title: 'settings.section.completion', render: renderCompletionSection },
	{ title: 'settings.section.model', render: renderModelSection },
	{ title: 'settings.section.semantic', render: renderSemanticSection },
	{ title: 'settings.section.learning', render: renderLearningSection },
	{ title: 'settings.section.data', render: renderDataSection },
	{ title: 'settings.section.diagnostics', render: renderDiagnosticsSection },
	{ title: 'settings.section.advanced', render: renderAdvancedSection },
];

export class PredictiveSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;

	constructor(app: App, plugin: Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('predictive-settings');

		new Setting(containerEl).setName(t('settings.title')).setHeading();

		// Always visible: the first thing a new user needs is how to make predictions work at all.
		const intro = containerEl.createDiv({ cls: 'predictive-intro' });
		intro.createEl('p', { text: t('settings.intro.modelSetup') });

		for (const category of CATEGORIES) {
			const { body } = addCollapsibleGroup(containerEl, {
				title: category.title,
				defaultOpen: false,
				cls: 'predictive-settings-section',
			});
			const ctx: SettingsSectionContext = {
				app: this.app,
				host: this.host,
				containerEl: body,
				refresh: () => this.display(),
			};
			category.render(ctx);
		}
	}
}
