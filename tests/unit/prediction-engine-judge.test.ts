/**
 * Prediction engine + relevance judge arbitration:
 * - local lexical filter flags a suspicious candidate;
 * - the model judge can only *keep* it (YES) or leave the rejection (NO/error);
 * - judge usage is merged into the request usage so diagnostics stay honest.
 */

import { describe, expect, it } from 'vitest';
import type {
	BuiltContext,
	ChatMessage,
	EditorSnapshot,
	ModelAdapter,
	ModelRequest,
	ModelResponse,
	TokenUsage,
} from '../../src/core/types';
import { PredictionEngine } from '../../src/prediction/engine';
import { ModelRelevanceJudge } from '../../src/prediction/relevance-judge';
import { createTokenBudget, fitSectionsToBudget } from '../../src/tokens/budget';
import { heuristicTokenCounter } from '../../src/tokens/estimator';

const UNRELATED =
	'清晨的海边十分安静，渔船缓缓驶离港口，远处的灯塔在薄雾中若隐若现。';
const EXPLANATION =
	'可以看作同一个线性变换在不同基下的表示，并通过可逆的基变换在两种表示之间转换。';

function snapshot(prefix: string): EditorSnapshot {
	return {
		docId: '',
		docVersion: 1,
		cursor: prefix.length,
		selectionFrom: prefix.length,
		selectionTo: prefix.length,
		prefix,
		prefixOffset: 0,
		suffix: '',
		line: 0,
		ch: prefix.length,
		lineTextBefore: prefix,
		lineTextAfter: '',
		isComposing: false,
		timestamp: Date.now(),
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
	};
}

function contextFor(prefix: string): BuiltContext {
	const snap = snapshot(prefix);
	const budget = createTokenBudget({ contextWindow: 8_192, reservedOutputTokens: 256 });
	const fitted = fitSectionsToBudget([{ id: 'before', label: 'before', trust: 'document', text: prefix, estimatedTokens: 1 }], budget, heuristicTokenCounter);
	return {
		snapshot: snap,
		sections: fitted.sections,
		report: fitted.report,
		createdAt: Date.now(),
		warmKey: null,
	};
}

const COMPLETION_USAGE: TokenUsage = {
	inputTokens: 300,
	outputTokens: 40,
	totalTokens: 340,
	estimated: false,
};
const JUDGE_USAGE: TokenUsage = {
	inputTokens: 60,
	outputTokens: 1,
	totalTokens: 61,
	estimated: false,
};

class FakeModel implements ModelAdapter {
	readonly id = 'fake';
	readonly modelId = 'fake-model';
	readonly contextWindow = 8_192;
	readonly calls: ModelRequest[] = [];

	constructor(
		private readonly completionText: string,
		private readonly judgeAnswer: string | Error,
	) {}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.calls.push(request);
		const isJudge = request.messages[0]?.content.includes('relevance checker') ?? false;
		if (isJudge) {
			if (this.judgeAnswer instanceof Error) throw this.judgeAnswer;
			return {
				text: this.judgeAnswer,
				finishReason: 'stop',
				usage: JUDGE_USAGE,
				modelId: this.modelId,
			};
		}
		return {
			text: this.completionText,
			finishReason: 'stop',
			usage: COMPLETION_USAGE,
			modelId: this.modelId,
		};
	}

	get judgeCalls(): ModelRequest[] {
		return this.calls.filter(
			(call) => call.messages[0]?.content.includes('relevance checker') ?? false,
		);
	}
}

function engineWith(model: FakeModel, withJudge: boolean): PredictionEngine {
	return new PredictionEngine({
		adapter: model,
		maxSuggestionChars: 4_000,
		offTopicFilter: true,
		relevanceJudge: withJudge ? new ModelRelevanceJudge(model) : undefined,
	});
}

const options = {
	requestId: 1,
	signal: new AbortController().signal,
	timeoutMs: 8_000,
	maxOutputTokens: 256,
	temperature: 0.2,
};

describe('relatedness arbitration', () => {
	it('lets the judge keep a related explanation that shares no literal term', async () => {
		const model = new FakeModel(EXPLANATION, 'YES');
		const outcome = await engineWith(model, true).predict(contextFor('矩阵相似'), options);
		expect(outcome.reason).toBeNull();
		expect(outcome.candidate?.text).toBe(EXPLANATION);
		expect(model.judgeCalls).toHaveLength(1);
		expect(outcome.usage).toEqual({
			inputTokens: 360,
			outputTokens: 41,
			totalTokens: 401,
			cachedInputTokens: 0,
			estimated: false,
		});
	});

	it('keeps the local rejection when the judge says NO', async () => {
		const model = new FakeModel(UNRELATED, 'NO');
		const outcome = await engineWith(model, true).predict(contextFor('线性代数'), options);
		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('off-topic');
		expect(model.judgeCalls).toHaveLength(1);
	});

	it('falls back to the local rejection when the judge fails', async () => {
		const model = new FakeModel(UNRELATED, new Error('judge timeout'));
		const outcome = await engineWith(model, true).predict(contextFor('线性代数'), options);
		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('off-topic');
	});

	it('does not ask the judge when the local filter is the only layer', async () => {
		const model = new FakeModel(UNRELATED, 'YES');
		const outcome = await engineWith(model, false).predict(contextFor('线性代数'), options);
		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('off-topic');
		expect(model.judgeCalls).toHaveLength(0);
	});
});
