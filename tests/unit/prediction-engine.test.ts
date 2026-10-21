import { describe, expect, it } from 'vitest';
import { ModelError } from '../../src/core/types';
import type {
	BuiltContext,
	ContextSection,
	EditorSnapshot,
	ModelAdapter,
	ModelRequest,
	ModelResponse,
	PredictOptions,
} from '../../src/core/types';
import { createTokenBudget, fitSectionsToBudget } from '../../src/tokens/budget';
import { heuristicTokenCounter } from '../../src/tokens/estimator';
import { PredictionEngine } from '../../src/prediction/engine';

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
	return {
		docId: 'Notes/test.md',
		docVersion: 3,
		cursor: 20,
		selectionFrom: 20,
		selectionTo: 20,
		prefix: 'The quick brown fox ',
		prefixOffset: 0,
		suffix: '',
		line: 0,
		ch: 20,
		lineTextBefore: 'The quick brown fox ',
		lineTextAfter: '',
		isComposing: false,
		timestamp: 0,
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
		...overrides,
	};
}

function makeContext(
	snapshot: EditorSnapshot,
	sections: ContextSection[] = [
		{ id: 'before', label: 'document-before-cursor', trust: 'document', text: snapshot.prefix, estimatedTokens: 8 },
	],
): BuiltContext {
	const budget = createTokenBudget({ contextWindow: 8_192, reservedOutputTokens: 256 });
	const fitted = fitSectionsToBudget(sections, budget, heuristicTokenCounter);
	return {
		snapshot,
		sections: fitted.sections,
		report: fitted.report,
		createdAt: 0,
		warmKey: null,
	};
}

function makeOptions(overrides: Partial<PredictOptions> = {}): PredictOptions {
	return {
		requestId: 7,
		signal: new AbortController().signal,
		timeoutMs: 5_000,
		maxOutputTokens: 128,
		temperature: 0.2,
		...overrides,
	};
}

class FakeAdapter implements ModelAdapter {
	readonly id = 'fake';
	readonly modelId = 'fake-model';
	readonly contextWindow = 8_192;
	readonly tokenCounter = heuristicTokenCounter;
	readonly requests: ModelRequest[] = [];
	private readonly handler: (request: ModelRequest) => Promise<ModelResponse>;

	constructor(handler: (request: ModelRequest) => Promise<ModelResponse>) {
		this.handler = handler;
	}

	complete(request: ModelRequest): Promise<ModelResponse> {
		this.requests.push(request);
		return this.handler(request);
	}
}

function response(
	text: string,
	finishReason: ModelResponse['finishReason'] = 'stop',
	usage: ModelResponse['usage'] = {
		inputTokens: 12,
		outputTokens: 4,
		totalTokens: 16,
		estimated: false,
	},
): ModelResponse {
	return { text, finishReason, usage, modelId: 'fake-model' };
}

describe('PredictionEngine.predict', () => {
	it('returns a complete candidate for a clean stop response', async () => {
		const adapter = new FakeAdapter(async () => response('jumped over the lazy dog.'));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const snapshot = makeSnapshot();
		const outcome = await engine.predict(makeContext(snapshot), makeOptions());

		expect(outcome.reason).toBeNull();
		expect(outcome.finishReason).toBe('stop');
		expect(outcome.candidate).not.toBeNull();
		const candidate = outcome.candidate;
		expect(candidate?.requestId).toBe(7);
		expect(candidate?.text).toBe('jumped over the lazy dog.');
		expect(candidate?.docId).toBe('Notes/test.md');
		expect(candidate?.docVersion).toBe(3);
		expect(candidate?.anchor).toBe(20);
		expect(candidate?.finishReason).toBe('stop');
		expect(candidate?.modelId).toBe('fake-model');
		expect(candidate?.source).toBe('model');
		expect(candidate?.degraded).toBe(false);
		expect(candidate?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(candidate?.usage?.estimated).toBe(false);
		expect(outcome.usage?.totalTokens).toBe(16);
	});

	it('sends exactly one request with the two prompt messages and the given options', async () => {
		const adapter = new FakeAdapter(async () => response(' next words here.'));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const controller = new AbortController();
		const options = makeOptions({ signal: controller.signal, requestId: 99, maxOutputTokens: 64, temperature: 0.5 });
		await engine.predict(makeContext(makeSnapshot()), options);

		expect(adapter.requests).toHaveLength(1);
		const sent = adapter.requests[0];
		expect(sent?.messages).toHaveLength(2);
		expect(sent?.messages[0]?.role).toBe('system');
		expect(sent?.messages[1]?.content).toContain('<cursor/>');
		expect(sent?.signal).toBe(controller.signal);
		expect(sent?.requestId).toBe(99);
		expect(sent?.maxOutputTokens).toBe(64);
		expect(sent?.temperature).toBe(0.5);
		expect(sent?.timeoutMs).toBe(5_000);
	});

	it('estimates usage when the provider omits it', async () => {
		const adapter = new FakeAdapter(async () => response('estimated continuation', 'stop', null));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.candidate).not.toBeNull();
		expect(outcome.usage?.estimated).toBe(true);
		expect(outcome.usage?.inputTokens).toBeGreaterThan(0);
		expect(outcome.usage?.outputTokens).toBeGreaterThan(0);
		expect(outcome.usage?.totalTokens).toBe(
			(outcome.usage?.inputTokens ?? 0) + (outcome.usage?.outputTokens ?? 0),
		);
	});

	it('repairs length-truncated output and marks the candidate degraded', async () => {
		const adapter = new FakeAdapter(async () =>
			response('A complete first sentence. And then the model was cut', 'length'),
		);
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.candidate?.text).toBe('A complete first sentence.');
		expect(outcome.candidate?.degraded).toBe(true);
		expect(outcome.candidate?.finishReason).toBe('length');
	});

	it('rejects unrepairable length-truncated output', async () => {
		const adapter = new FakeAdapter(async () =>
			response('a fragment with no terminal punctuation here', 'length'),
		);
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('truncated');
		expect(outcome.finishReason).toBe('length');
	});

	it('rejects suggestions that echo the document suffix', async () => {
		const adapter = new FakeAdapter(async () => response('the lazy dog.'));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(
			makeContext(makeSnapshot({ suffix: 'the lazy dog.' })),
			makeOptions(),
		);

		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('echo');
	});

	it('does not throw on a provider timeout', async () => {
		const adapter = new FakeAdapter(async () => {
			throw new ModelError('timeout', 'timed out');
		});
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome).toEqual({ candidate: null, reason: 'timeout', usage: null, finishReason: null, modelCalls: [{ usage: null, failed: true }] });
	});

	it('does not throw when the request was aborted', async () => {
		const adapter = new FakeAdapter(async () => {
			throw new ModelError('aborted', 'aborted');
		});
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.reason).toBe('aborted');
		expect(outcome.candidate).toBeNull();
	});

	it('maps unexpected adapter failures to reason error', async () => {
		const adapter = new FakeAdapter(async () => {
			throw new Error('boom');
		});
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.reason).toBe('error');
		expect(outcome.candidate).toBeNull();
	});

	it('rejects content-filtered responses through the validator', async () => {
		const adapter = new FakeAdapter(async () => response('blocked text', 'content_filter'));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		const outcome = await engine.predict(makeContext(makeSnapshot()), makeOptions());

		expect(outcome.candidate).toBeNull();
		expect(outcome.reason).toBe('validator-rejected');
		expect(outcome.finishReason).toBe('content_filter');
	});

	it('exposes the adapter model id and context window', () => {
		const adapter = new FakeAdapter(async () => response('x'));
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		expect(engine.modelId).toBe('fake-model');
		expect(engine.contextWindow).toBe(8_192);
	});

	it('never retries a failed request', async () => {
		let calls = 0;
		const adapter = new FakeAdapter(async () => {
			calls++;
			throw new ModelError('server', 'down');
		});
		const engine = new PredictionEngine({ adapter, maxSuggestionChars: 500 });
		await engine.predict(makeContext(makeSnapshot()), makeOptions());
		expect(calls).toBe(1);
		expect(adapter.requests).toHaveLength(1);
	});
});
