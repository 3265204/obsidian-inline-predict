// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Setting } from 'obsidian';
import type { App, Plugin, SettingDefinitionRender, SettingGroup } from 'obsidian';
import { PredictiveSettingTab } from '../../src/ui/settings-tab';
import { renderCompletionSection } from '../../src/ui/settings/completion-section';
import type { SettingsHost } from '../../src/ui/settings/host';
import { DEFAULT_SETTINGS } from '../../src/settings/schema';
import { setLocale, t } from '../../src/i18n';

vi.mock('../../src/ui/settings/completion-section', () => ({ renderCompletionSection: vi.fn() }));

function setup() {
	const host: SettingsHost = {
		getSettings: vi.fn(() => DEFAULT_SETTINGS),
		updateSettings: vi.fn(async () => undefined),
		getDiagnostics: vi.fn(() => { throw new Error('Metadata must not read diagnostics'); }),
		rebuildIndex: vi.fn(async () => undefined),
		clearCaches: vi.fn(async () => undefined),
		exportProfile: vi.fn(async () => ''),
		importProfile: vi.fn(async () => undefined),
		clearProfile: vi.fn(async () => undefined),
		getSemanticStatus: vi.fn(() => ({ enabled: false, available: false, reason: '' })),
		testConnection: vi.fn(async () => ({ ok: true, message: '' })),
	};
	const tab = new PredictiveSettingTab({} as App, {} as Plugin, host);
	tab.containerEl = document.createElement('div');
	return { tab, host };
}

afterEach(() => { setLocale('en'); vi.clearAllMocks(); });

describe('声明式设置与搜索', () => {
	it.each(['en', 'zh-cn'])('元数据在 %s 中包含分类内的搜索词且不发起请求', (locale) => {
		setLocale(locale);
		const { tab, host } = setup();
		const definitions = tab.getSettingDefinitions();
		expect(definitions).toHaveLength(8);
		const model = definitions.find((item) => 'name' in item && item.name === t('settings.section.model'));
		expect(model).toMatchObject({ aliases: expect.arrayContaining([t('settings.model.apiKey.name'), t('settings.model.reasoningEffort.name')]) });
		expect(host.getSettings).not.toHaveBeenCalled();
		expect(host.getDiagnostics).not.toHaveBeenCalled();
		expect(host.testConnection).not.toHaveBeenCalled();
		expect(host.updateSettings).not.toHaveBeenCalled();
	});
	it('刷新保留折叠状态，并使用 update() 重新索引设置', () => {
		const { tab } = setup();
		const definition = tab.getSettingDefinitions().find((item) => 'name' in item && item.name === t('settings.section.completion')) as SettingDefinitionRender;
		const row = document.createElement('div');
		definition.render(new Setting(row), {} as SettingGroup);
		const details = row.querySelector('details');
		expect(details?.open).toBe(false);
		if (details) { details.open = true; details.dispatchEvent(new Event('toggle')); }
		expect(details?.open).toBe(true);
		const refresh = vi.spyOn(tab, 'update');
		vi.mocked(renderCompletionSection).mock.calls[0]?.[0].refresh();
		expect(refresh).toHaveBeenCalledOnce();
		const nextRow = document.createElement('div');
		definition.render(new Setting(nextRow), {} as SettingGroup);
		expect(nextRow.querySelector('details')?.open).toBe(true);
	});
});
