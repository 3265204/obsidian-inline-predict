/**
 * Small indirection layer used by the composition root.
 *
 * A scheduler is created per editor view, but the model adapter and context engine can be
 * rebuilt when settings change. These facades keep the scheduler's dependencies stable while
 * delegating to the currently configured instances, without making the scheduler aware of
 * settings at all.
 */

import type {
	BuiltContext,
	ContextBuilder,
	EditorSnapshot,
	PredictionOutcome,
	PredictionRunner,
	PredictOptions,
} from '../core/types';
import { createTokenBudget, fitSectionsToBudget } from '../tokens/budget';
import { heuristicTokenCounter } from '../tokens/estimator';

const NO_MODEL_OUTCOME: PredictionOutcome = {
	candidate: null,
	reason: 'no-model',
	usage: null,
	finishReason: null,
	modelCalls: [],
};

export class SwappableRunner implements PredictionRunner {
	private current: PredictionRunner | null = null;
	private currentModelId = '';
	private currentContextWindow = 4096;

	get modelId(): string {
		return this.currentModelId;
	}

	get contextWindow(): number {
		return this.currentContextWindow;
	}

	set(runner: PredictionRunner | null): void {
		this.current = runner;
		this.currentModelId = runner?.modelId ?? '';
		this.currentContextWindow = runner?.contextWindow ?? 4096;
	}

	async predict(context: BuiltContext, options: PredictOptions): Promise<PredictionOutcome> {
		if (this.current === null) return NO_MODEL_OUTCOME;
		return this.current.predict(context, options);
	}
}

export class SwappableContextBuilder implements ContextBuilder {
	private current: ContextBuilder | null = null;

	set(builder: ContextBuilder | null): void {
		this.current = builder;
	}

	async build(snapshot: EditorSnapshot, signal: AbortSignal): Promise<BuiltContext> {
		if (this.current !== null) return this.current.build(snapshot, signal);
		// Without a configured model there is nothing to prompt, but the scheduler may still ask
		// for a context (e.g. manual trigger). Return an honestly empty payload.
		const budget = createTokenBudget({ contextWindow: 1024, reservedOutputTokens: 256 });
		const fitted = fitSectionsToBudget([], budget, heuristicTokenCounter);
		return {
			snapshot,
			sections: fitted.sections,
			report: fitted.report,
			createdAt: Date.now(),
			warmKey: null,
		};
	}

	invalidate(docId?: string): void {
		this.current?.invalidate(docId);
	}
}

/** Convenience bundle for `main.ts`. */
export interface PredictionStack {
	runner: SwappableRunner;
	contextBuilder: SwappableContextBuilder;
}

export function createPredictionStack(): PredictionStack {
	return {
		runner: new SwappableRunner(),
		contextBuilder: new SwappableContextBuilder(),
	};
}
