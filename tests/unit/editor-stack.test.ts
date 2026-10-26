// @vitest-environment jsdom
import { testTimers } from '../helpers/timers';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createCompletionIntegration, type CompletionIntegration } from '../../src/completion/controller';
import { getGhostSuggestion } from '../../src/editor/ghost-text';
import { ContextEngine } from '../../src/context/context-engine';
import { PredictionEngine } from '../../src/prediction/engine';
import { CompletionScheduler } from '../../src/scheduler/scheduler';
import { LruPredictionCache } from '../../src/scheduler/prediction-cache';
import { Telemetry } from '../../src/telemetry/stats';
import { applySettingsPatch, DEFAULT_SETTINGS } from '../../src/settings/schema';
import type { ModelAdapter, ModelRequest } from '../../src/core/types';

const open: { view: EditorView; integration: CompletionIntegration }[] = [];
afterEach(() => { for (const item of open.splice(0)) { item.integration.destroy(); item.view.destroy(); } });
async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }

async function setup(doc = 'Hello ', cursor = 6, completion = 'world world peace.') {
	let calls = 0;
	const requests: ModelRequest[] = [];
	const adapter: ModelAdapter = { id: 'fake', modelId: 'fake', contextWindow: 8192,
		async complete(request) { calls++; requests.push(request); return { text: completion, finishReason: 'stop', usage: null, modelId: 'fake' }; } };
	const telemetry = new Telemetry();
	const settings = applySettingsPatch(DEFAULT_SETTINGS, { completion: { autoTrigger: false } });
	const integration = createCompletionIntegration({ getSettings: () => settings,
		getDocInfo: () => ({ docId: 'note.md', mode: 'source', language: 'markdown' }),
		createScheduler: (events) => new CompletionScheduler({ timers: testTimers,
			contextBuilder: new ContextEngine({ modelContextWindow: 8192, maxOutputTokens: 256 }),
			runner: new PredictionEngine({ adapter, maxSuggestionChars: 4000 }), cache: new LruPredictionCache(), telemetry,
			getConfig: () => ({ baseDebounceMs: 400, minRequestIntervalMs: 350, maxOutputTokens: 256,
				requestTimeoutMs: 8000, temperature: 0.2, cacheEntries: 64, contextCacheEntries: 32, debug: false, autoTrigger: false }), events }),
	});
	const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [integration.extension] }), parent: document.body });
	open.push({ view, integration });
	await flush(); integration.requestNow(); await flush();
	return { view, integration, telemetry, requests, calls: () => calls };
}

describe('真实编辑器、控制器和调度器的衔接', () => {
	it('文中补全发送完整缺口上下文，不按后文词面拦截候选', async () => {
		const prefix = '这里是';
		const suffix = '，是城市公共图书馆的主要入口';
		const doc = prefix + suffix;
		const h = await setup(doc, prefix.length, '城市公共图书馆的主要入口，同时也是社区活动的重要场所。');
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('城市公共图书馆的主要入口，同时也是社区活动的重要场所。');
		expect(h.requests[0]?.messages[1]?.content).toContain(`<document-around-cursor>${prefix}<cursor/>${suffix}</document-around-cursor>`);
		expect(h.view.state.doc.toString()).toBe(doc);
		expect(h.calls()).toBe(1);
		expect(h.telemetry.snapshot().candidatesShown).toBe(1);
	});

	it('文中灰字不改文档，部分和完整接受保留后文与衔接空格', async () => {
		const h = await setup('The fox.', 4, 'quick brown ');
		expect(h.view.state.doc.toString()).toBe('The fox.');
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('quick brown ');
		expect(h.requests[0]?.messages[1]?.content).toContain('<cursor/>fox.</document-around-cursor>');
		expect(h.integration.acceptWord()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('The quick fox.');
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('brown ');
		expect(h.integration.acceptAll()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('The quick brown fox.');
		expect(getGhostSuggestion(h.view.state)).toBeNull();
		expect(h.calls()).toBe(1);
	});

	it('连续部分接受重复词时，每个插入只消费一次', async () => {
		const h = await setup();
		expect(h.integration.acceptWord()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('Hello world ');
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('world peace.');
		expect(h.integration.acceptWord()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('Hello world world ');
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('peace.');
		expect(h.integration.acceptAll()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('Hello world world peace.');
		expect(getGhostSuggestion(h.view.state)).toBeNull();
		expect(h.telemetry.snapshot()).toMatchObject({ candidatesShown: 1, acceptedSuggestions: 1, partialAccepts: 2, fullAccepts: 1 });
		expect(h.calls()).toBe(1);
	});

	it('连续输入匹配文字并更新相同光标时，灰字不会恢复完整候选', async () => {
		const h = await setup();
		for (const text of ['world ', 'w', 'o']) {
			const from = h.view.state.selection.main.head;
			h.view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length } });
			await flush();
		}
		const cursor = h.view.state.selection.main.head;
		h.view.dispatch({ selection: { anchor: cursor } }); await flush();
		expect(getGhostSuggestion(h.view.state)?.remainingText).toBe('rld peace.');
		expect(h.integration.acceptAll()).toBe(true);
		expect(h.view.state.doc.toString()).toBe('Hello world world peace.');
		expect(h.calls()).toBe(1);
	});
});
