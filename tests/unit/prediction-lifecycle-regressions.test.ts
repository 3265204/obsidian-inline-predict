import { testTimers } from '../helpers/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError, type EditorSnapshot, type ModelAdapter, type ModelErrorKind, type ModelRequest, type ModelResponse } from '../../src/core/types';
import { ContextEngine } from '../../src/context/context-engine';
import { PredictionEngine } from '../../src/prediction/engine';
import { ModelRelevanceJudge } from '../../src/prediction/relevance-judge';
import { CompletionScheduler, type SchedulerConfig } from '../../src/scheduler/scheduler';
import { LruPredictionCache } from '../../src/scheduler/prediction-cache';
import { Telemetry } from '../../src/telemetry/stats';

function snapshot(prefix = 'Hello ', docVersion = 1): EditorSnapshot {
	return { docId: 'note.md', docVersion, cursor: prefix.length, selectionFrom: prefix.length, selectionTo: prefix.length,
		prefix, prefixOffset: 0, suffix: '', line: 0, ch: prefix.length, lineTextBefore: prefix, lineTextAfter: '',
		isComposing: false, timestamp: Date.now(), trigger: 'doc-change', lastEdit: null, language: 'markdown', mode: 'source', inCodeBlock: false, inMathBlock: false };
}

function response(text = 'world peace.', usage: ModelResponse['usage'] = { inputTokens: 100, outputTokens: 10, totalTokens: 110, estimated: false }): ModelResponse {
	return { text, finishReason: 'stop', modelId: 'fake', usage };
}

function setup(reply: (request: ModelRequest, index: number) => Promise<ModelResponse>, judge = false) {
	const requests: ModelRequest[] = [];
	const adapter: ModelAdapter = { id: 'fake', modelId: 'fake', contextWindow: 8192,
		complete(request) { requests.push(request); return reply(request, requests.length); } };
	const telemetry = new Telemetry();
	const config: SchedulerConfig = { baseDebounceMs: 400, minRequestIntervalMs: 350, maxOutputTokens: 256,
		requestTimeoutMs: 8000, temperature: 0.2, cacheEntries: 64, contextCacheEntries: 32, debug: false, autoTrigger: false, configurationVersion: 0 };
	const scheduler = new CompletionScheduler({ timers: testTimers, contextBuilder: new ContextEngine({ modelContextWindow: 8192, maxOutputTokens: 256 }),
		runner: new PredictionEngine({ adapter, maxSuggestionChars: 4000, relevanceJudge: judge ? new ModelRelevanceJudge(adapter) : undefined }),
		cache: new LruPredictionCache(), telemetry, getConfig: () => config, events: { onStatus: () => undefined, onSuggestion: () => undefined } });
	return { scheduler, telemetry, config, requests };
}

async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('真实预测引擎与调度器的回归路径', () => {
	it.each(['auth', 'timeout', 'rate-limit', 'network'] satisfies ModelErrorKind[])('%s 失败会退避，手动命令也不能立即重试', async (kind) => {
		const h = setup(async () => { throw new ModelError(kind, 'test failure'); });
		h.scheduler.updateCursor(snapshot());
		h.scheduler.requestNow();
		await flush();
		expect(h.scheduler.getStatus()).toBe('backoff');
		expect(h.telemetry.snapshot()).toMatchObject({ requests: 1, requestFailures: 1, modelCalls: 1, unknownUsageCalls: 1, modelCallFailures: 1 });
		h.scheduler.requestNow();
		await vi.advanceTimersByTimeAsync(1499);
		expect(h.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.requests).toHaveLength(2);
		h.scheduler.dispose();
	});

	it('过期结果不展示，但供应商返回的用量仍被记录', async () => {
		let resolve: ((value: ModelResponse) => void) | undefined;
		const h = setup(() => new Promise((done) => { resolve = done; }));
		h.scheduler.updateCursor(snapshot()); h.scheduler.requestNow(); await flush();
		h.scheduler.updateCursor(snapshot('Other ', 2));
		resolve?.(response()); await flush();
		expect(h.scheduler.current()).toBeNull();
		expect(h.scheduler.getStaleDrops()).toBe(1);
		expect(h.telemetry.snapshot()).toMatchObject({ requests: 1, modelCalls: 1, inputTokens: 100, outputTokens: 10 });
		h.scheduler.dispose();
	});

	it('配置刷新取消旧请求，旧响应不能覆盖新候选，但仍保留用量', async () => {
		let resolve: ((value: ModelResponse) => void) | undefined;
		const h = setup(async (_request, index) => index === 1 ? new Promise((done) => { resolve = done; }) : response('fresh result.'));
		h.scheduler.updateCursor(snapshot()); h.scheduler.requestNow(); await flush();
		h.config.configurationVersion = 1; h.scheduler.refresh();
		expect(h.requests[0]?.signal.aborted).toBe(true);
		h.scheduler.requestNow(); await flush();
		resolve?.(response('obsolete result.')); await flush();
		expect(h.scheduler.current()?.remainingText).toBe('fresh result.');
		expect(h.telemetry.snapshot()).toMatchObject({ requests: 2, modelCalls: 2, inputTokens: 200 });
		h.scheduler.dispose();
	});

	it('相关性复核按独立调用统计，缺少 usage 时单独估算', async () => {
		const h = setup(async (_request, index) => index === 1
			? response('清晨的海边十分安静，渔船缓缓驶离港口，远处的灯塔在薄雾中若隐若现。')
			: response('NO', null), true);
		h.scheduler.updateCursor(snapshot('线性代数')); h.scheduler.requestNow(); await flush();
		expect(h.requests).toHaveLength(2);
		expect(h.telemetry.snapshot()).toMatchObject({ requests: 1, modelCalls: 2, providerUsageCalls: 1,
			estimatedUsageRequests: 1, unknownUsageCalls: 0, offTopicRejections: 1 });
		expect(h.telemetry.snapshot().inputTokens).toBeGreaterThan(100);
		h.scheduler.dispose();
	});
});
