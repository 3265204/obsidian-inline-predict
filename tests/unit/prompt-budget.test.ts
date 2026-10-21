import { describe, expect, it } from 'vitest';
import { ContextEngine } from '../../src/context/context-engine';
import { PredictionEngine } from '../../src/prediction/engine';
import { buildPromptMessages } from '../../src/prediction/prompt-builder';
import { heuristicTokenCounter } from '../../src/tokens/estimator';
import type { EditorSnapshot, ModelAdapter, ModelRequest } from '../../src/core/types';

function snapshot(): EditorSnapshot {
	const prefix = '中文上下文'.repeat(1200);
	return { docId: 'note.md', docVersion: 1, cursor: prefix.length, selectionFrom: prefix.length, selectionTo: prefix.length,
		prefix, prefixOffset: 0, suffix: '这是后文。', line: 0, ch: prefix.length, lineTextBefore: prefix, lineTextAfter: '',
		isComposing: false, timestamp: 0, trigger: 'doc-change', lastEdit: null, language: 'markdown', mode: 'source', inCodeBlock: false, inMathBlock: false };
}

describe('最终消息预算', () => {
	it('公式格式规则进入真实模型请求，并只返回光标处续写', async () => {
		const calls: ModelRequest[] = [];
		const adapter: ModelAdapter = {
			id: 'fake', modelId: 'fake', contextWindow: 8192,
			async complete(request) {
				calls.push(request);
				return { text: '=mc^2', finishReason: 'stop', usage: null, modelId: 'fake' };
			},
		};
		const prefix = '能量公式 $E';
		const suffix = '$ 与质量相关。';
		const value = { ...snapshot(), prefix, suffix, cursor: prefix.length, selectionFrom: prefix.length, selectionTo: prefix.length, lineTextBefore: prefix, lineTextAfter: suffix };
		const context = await new ContextEngine({ modelContextWindow: 8192, maxOutputTokens: 256 }).build(value, new AbortController().signal);
		const outcome = await new PredictionEngine({ adapter, maxSuggestionChars: 100 }).predict(context, {
			requestId: 1, signal: new AbortController().signal, timeoutMs: 1000, maxOutputTokens: 256, temperature: 0.2,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.messages[0]?.content).toContain('$...$ for inline math');
		expect(calls[0]?.messages[0]?.content).toContain('$$...$$ for a standalone formula');
		expect(outcome.candidate?.text).toBe('=mc^2');
		expect(prefix + outcome.candidate?.text + suffix).toBe('能量公式 $E=mc^2$ 与质量相关。');
	});

	it('系统提示、标签、输入和输出预留共同满足窗口上限', async () => {
		const calls: ModelRequest[] = [];
		const adapter: ModelAdapter = { id: 'fake', modelId: 'fake', contextWindow: 1024, tokenCounter: heuristicTokenCounter,
			async complete(request) { calls.push(request); return { text: '继续写作。', finishReason: 'stop', usage: null, modelId: 'fake' }; } };
		const context = await new ContextEngine({ modelContextWindow: 1024, maxOutputTokens: 256 }).build(snapshot(), new AbortController().signal);
		await new PredictionEngine({ adapter, maxSuggestionChars: 100 }).predict(context, {
			requestId: 1, signal: new AbortController().signal, timeoutMs: 1000, maxOutputTokens: 256, temperature: 0.2,
		});
		expect(calls).toHaveLength(1);
		const request = calls[0];
		if (!request) throw new Error('没有发出请求');
		expect(heuristicTokenCounter.countMessages(request.messages) + 256 + 16).toBeLessThanOrEqual(1024);
	});

	it('窗口不足时跳过模型，不恢复已省略的正文', async () => {
		let calls = 0;
		const adapter: ModelAdapter = { id: 'fake', modelId: 'fake', contextWindow: 256,
			async complete() { calls++; return { text: '', finishReason: 'stop', usage: null, modelId: 'fake' }; } };
		const value = snapshot();
		const context = await new ContextEngine({ modelContextWindow: 256, maxOutputTokens: 256 }).build(value, new AbortController().signal);
		expect(buildPromptMessages({ sections: context.sections, snapshot: value })[1]?.content).not.toContain(value.prefix);
		const outcome = await new PredictionEngine({ adapter, maxSuggestionChars: 100 }).predict(context, {
			requestId: 1, signal: new AbortController().signal, timeoutMs: 1000, maxOutputTokens: 256, temperature: 0.2,
		});
		expect(outcome.reason).toBe('budget-exceeded');
		expect(outcome.modelCalls).toEqual([]);
		expect(calls).toBe(0);
	});
});
