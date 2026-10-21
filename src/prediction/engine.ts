/** 构建受预算约束的提示词，调用模型并验证结果。调度、复用和退避由调度模块负责。 */
import {
	ModelError,
	type BuiltContext,
	type ChatMessage,
	type ChatTokenCounter,
	type CompletionCandidate,
	type ModelAdapter,
	type ModelCallRecord,
	type ModelRequest,
	type ModelResponse,
	type PredictionOutcome,
	type PredictionRunner,
	type PredictOptions,
	type PredictionSkipReason,
	type TokenUsage,
} from '../core/types';
import { heuristicTokenCounter } from '../tokens/estimator';
import { buildBudgetedPrompt } from './prompt-budget';
import { mergeUsage } from './relevance-judge';
import type { RelevanceJudge } from './relevance-judge';
import { validateSuggestion } from './validator';

export interface PredictionEngineOptions {
	adapter: ModelAdapter;
	maxSuggestionChars: number;
	tokenCounter?: ChatTokenCounter;
	/** Local relatedness gate (default on; see settings.completion.filterOffTopic). */
	offTopicFilter?: boolean;
	/** Optional model-backed check for candidates the local gate finds suspicious. */
	relevanceJudge?: RelevanceJudge;
}

function emptyOutcome(reason: PredictionSkipReason, modelCalls: readonly ModelCallRecord[] = []): PredictionOutcome {
	return { candidate: null, reason, usage: null, finishReason: null, modelCalls };
}

function skipReasonForError(error: unknown, signal: AbortSignal): PredictionSkipReason {
	if (signal.aborted) return 'aborted';
	if (error instanceof ModelError) {
		if (error.kind === 'aborted') return 'aborted';
		if (error.kind === 'timeout') return 'timeout';
		if (error.kind === 'rate-limit') return 'rate-limited';
	}
	return 'error';
}

export class PredictionEngine implements PredictionRunner {
	readonly modelId: string;
	readonly contextWindow: number;

	private readonly adapter: ModelAdapter;
	private readonly maxSuggestionChars: number;
	private readonly tokenCounter: ChatTokenCounter;
	private readonly offTopicFilter: boolean;
	private readonly relevanceJudge: RelevanceJudge | null;

	constructor(options: PredictionEngineOptions) {
		this.adapter = options.adapter;
		this.maxSuggestionChars = options.maxSuggestionChars;
		this.modelId = options.adapter.modelId;
		this.contextWindow = options.adapter.contextWindow;
		this.tokenCounter = options.tokenCounter ?? options.adapter.tokenCounter ?? heuristicTokenCounter;
		this.offTopicFilter = options.offTopicFilter ?? true;
		this.relevanceJudge = options.relevanceJudge ?? null;
	}

	async predict(context: BuiltContext, options: PredictOptions): Promise<PredictionOutcome> {
		if (options.signal.aborted) return emptyOutcome('aborted');
		const messages = buildBudgetedPrompt(context, this.contextWindow, options.maxOutputTokens, this.tokenCounter);
		if (messages === null) return emptyOutcome('budget-exceeded');
		const startedAt = Date.now();
		let response: ModelResponse;
		try {
			response = await this.adapter.complete({
				messages,
				maxOutputTokens: options.maxOutputTokens,
				temperature: options.temperature,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				requestId: options.requestId,
			} satisfies ModelRequest);
		} catch (error) {
			const reason = skipReasonForError(error, options.signal);
			return emptyOutcome(reason, [{ usage: null, failed: reason !== 'aborted' }]);
		}

		const validation = validateSuggestion({
			response,
			snapshot: context.snapshot,
			maxChars: this.maxSuggestionChars,
			offTopicFilter: this.offTopicFilter,
		});
		let usage = response.usage ?? this.estimateUsage(messages, response.text);
		const modelCalls: ModelCallRecord[] = [{ usage, failed: false }];
		let latencyMs = Math.max(0, Date.now() - startedAt);
		if (validation.rejected === 'off-topic') {
			// Local lexical check found no shared term. Only the model can tell a paraphrase-style
			// explanation from unrelated boilerplate; ask it, and keep the local (negative) decision
			// if the judge fails. The extra call happens only for suspicious output.
			if (this.relevanceJudge === null || validation.text === null) {
				return {
					candidate: null,
					reason: 'off-topic',
					usage,
					finishReason: response.finishReason,
					modelCalls,
				};
			}
			const judged = await this.relevanceJudge.judge({
				context: context.snapshot.prefix,
				candidate: validation.text,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				requestId: options.requestId,
			});
			usage = mergeUsage(usage, judged.usage);
			if (judged.call) modelCalls.push(judged.call);
			latencyMs = Math.max(0, Date.now() - startedAt);
			if (judged.related !== true) {
				return {
					candidate: null,
					reason: 'off-topic',
					usage,
					finishReason: response.finishReason,
					modelCalls,
				};
			}
		}
		if (validation.text === null) {
			return {
				candidate: null,
				reason: validation.rejected ?? 'validator-rejected',
				usage,
				finishReason: response.finishReason,
				modelCalls,
			};
		}

		const text = validation.text;
		const candidate: CompletionCandidate = {
			requestId: options.requestId,
			text,
			docId: context.snapshot.docId,
			docVersion: context.snapshot.docVersion,
			anchor: context.snapshot.cursor,
			finishReason: response.finishReason,
			usage,
			modelId: this.modelId,
			createdAt: Date.now(),
			latencyMs,
			source: 'model',
			degraded: validation.degraded,
			reuseContext: {
				prefix: context.snapshot.prefix,
				prefixOffset: context.snapshot.prefixOffset,
				suffix: context.snapshot.suffix,
			},
		};
		return {
			candidate,
			reason: null,
			usage,
			finishReason: response.finishReason,
			modelCalls,
		};
	}

	private estimateUsage(messages: readonly ChatMessage[], output: string): TokenUsage {
		const inputTokens = this.tokenCounter.countMessages(messages);
		const outputTokens = this.tokenCounter.count(output);
		return {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			estimated: true,
		};
	}
}
