/**
 * Model-backed relevance judge. Only suspicious candidates reach it, so the cost is bounded; a
 * judge failure must never turn into a shown suggestion.
 */

import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../../src/core/types';
import {
	ModelRelevanceJudge,
	mergeUsage,
	parseRelevanceAnswer,
} from '../../src/prediction/relevance-judge';

class ScriptedAdapter implements ModelAdapter {
	readonly id = 'scripted';
	readonly modelId = 'scripted-model';
	readonly contextWindow = 8_192;
	readonly calls: ModelRequest[] = [];

	constructor(private readonly reply: (callIndex: number) => ModelResponse | Error) {}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.calls.push(request);
		const value = this.reply(this.calls.length - 1);
		if (value instanceof Error) throw value;
		return value;
	}
}

function response(text: string, inputTokens = 10, outputTokens = 1): ModelResponse {
	return {
		text,
		finishReason: 'stop',
		usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: false },
		modelId: 'scripted-model',
	};
}

const input = {
	context: '线性代数',
	candidate: '清晨的海边十分安静，渔船缓缓驶离港口，远处的灯塔在薄雾中若隐若现。',
	signal: new AbortController().signal,
	timeoutMs: 4_000,
	requestId: 7,
};

describe('parseRelevanceAnswer', () => {
	it('parses plain and decorated answers', () => {
		expect(parseRelevanceAnswer('YES')).toBe(true);
		expect(parseRelevanceAnswer('No.')).toBe(false);
		expect(parseRelevanceAnswer('**yes**')).toBe(true);
		expect(parseRelevanceAnswer('「NO」')).toBe(false);
		expect(parseRelevanceAnswer('maybe')).toBeNull();
		expect(parseRelevanceAnswer('')).toBeNull();
	});
});

describe('ModelRelevanceJudge', () => {
	it('被截断的 YES 不作为可靠复核结果，但仍记录调用用量', async () => {
		const adapter = new ScriptedAdapter(() => ({ ...response('YES'), finishReason: 'length' }));
		const result = await new ModelRelevanceJudge(adapter).judge(input);
		expect(result.related).toBeNull();
		expect(result.call?.usage?.totalTokens).toBe(11);
	});
	it('asks a single yes/no question and returns the parsed answer with usage', async () => {
		const adapter = new ScriptedAdapter(() => response('NO', 40, 1));
		const result = await new ModelRelevanceJudge(adapter).judge(input);
		expect(result.related).toBe(false);
		expect(result.usage?.inputTokens).toBe(40);
		expect(adapter.calls).toHaveLength(1);
		expect(adapter.calls[0]?.maxOutputTokens).toBe(4);
		expect(adapter.calls[0]?.temperature).toBe(0);
	});

	it('returns null on provider failure (engine keeps the local rejection)', async () => {
		const adapter = new ScriptedAdapter(() => new Error('boom'));
		const result = await new ModelRelevanceJudge(adapter).judge(input);
		expect(result.related).toBeNull();
	});
});

describe('mergeUsage', () => {
	it('adds completion and judge usage', () => {
		const merged = mergeUsage(
			{ inputTokens: 100, outputTokens: 5, totalTokens: 105, estimated: false },
			{ inputTokens: 40, outputTokens: 1, totalTokens: 41, estimated: false },
		);
		expect(merged).toEqual({
			inputTokens: 140,
			outputTokens: 6,
			totalTokens: 146,
			cachedInputTokens: 0,
			estimated: false,
		});
	});

	it('returns the completion usage when the judge did not report usage', () => {
		const base = { inputTokens: 100, outputTokens: 5, totalTokens: 105, estimated: true };
		expect(mergeUsage(base, null)).toEqual(base);
	});
});
