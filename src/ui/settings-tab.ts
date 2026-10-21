/**
 * Inline Predict 设置页面。
 *
 * Every top-level category is one collapsible group containing *all* of its options — no mixed
 * states where part of a category is visible and part is hidden. The tab itself only owns the
 * group shell and ordering; section renderers fill the group body and never create headings.
 */

import { PluginSettingTab } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
import { en } from '../i18n/en';
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: t('settings.intro.modelSetup'),
				searchable: false,
				render: (setting) => {
					setting.settingEl.empty();
					setting.settingEl.addClass('predictive-intro');
					setting.settingEl.createEl('p', { text: t('settings.intro.modelSetup') });
				},
			},
			...CATEGORIES.map((category) => ({
				name: t(category.title),
				// 将分类内的名称和说明纳入搜索，避免只搜得到分类标题。
				aliases: this.categoryAliases(category),
				render: (setting: Setting) => this.renderCategory(setting, category),
			})),
		];
	}

	private categoryAliases(category: SettingsCategory): string[] {
		const key = category.title.slice('settings.section.'.length);
		return (Object.keys(en) as TranslationKey[])
			.filter((name) => name.startsWith(`settings.${key}.`))
			.map((name) => t(name));
	}

	private renderCategory(setting: Setting, category: SettingsCategory): void {
		this.containerEl.addClass('predictive-settings');
		setting.settingEl.empty();
		setting.settingEl.addClass('predictive-category');
		const { body } = addCollapsibleGroup(setting.settingEl, {
			title: category.title,
			defaultOpen: false,
			cls: 'predictive-settings-section',
		});
		category.render({
			app: this.app,
			host: this.host,
			containerEl: body,
			refresh: () => this.update(),
		});
	}
}
