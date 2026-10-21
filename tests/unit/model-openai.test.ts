import { testTimers } from '../helpers/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError, type ModelRequest, type TokenUsage } from '../../src/core/types';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/model/transport';

/**
 * `createObsidianHttpTransport` imports `requestUrl` from the `obsidian` module, which vitest
 * aliases to its stub. We replace it with a controllable mock so transport timing/abort can be
 * tested without any network or real Obsidian runtime.
 */
const requestUrlMock = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl: requestUrlMock }));

import { OpenAICompatibleAdapter, parseChatCompletion } from '../../src/model/openai-chat';
import { createObsidianHttpTransport } from '../../src/model/transport';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

class FakeTransport implements HttpTransport {
	readonly requests: HttpRequest[] = [];
	private readonly handler: (request: HttpRequest) => Promise<HttpResponse>;

	constructor(handler: (request: HttpRequest) => Promise<HttpResponse>) {
		this.handler = handler;
	}

	post(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		return this.handler(request);
	}
}

function bodyResponse(status: number, body: unknown) {
	return async (): Promise<HttpResponse> => ({ status, text: JSON.stringify(body) });
}

function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'chatcmpl-1',
		model: 'gpt-test-echo',
		choices: [{ message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
		...overrides,
	};
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
	return {
		messages: [
			{ role: 'system', content: 'rules' },
			{ role: 'user', content: 'text' },
		],
		maxOutputTokens: 128,
		temperature: 0.2,
		signal: new AbortController().signal,
		timeoutMs: 5_000,
		requestId: 42,
		...overrides,
	};
}

function makeAdapter(handler: (request: HttpRequest) => Promise<HttpResponse>) {
	const transport = new FakeTransport(handler);
	const adapter = new OpenAICompatibleAdapter({
		baseUrl: 'https://api.example.test/v1',
		apiKey: 'sk-test-key',
		modelId: 'gpt-test',
		transport,
	});
	return { adapter, transport };
}

async function captureError(promise: Promise<unknown>): Promise<ModelError> {
	try {
		await promise;
	} catch (error) {
		return error as ModelError;
	}
	throw new Error('expected promise to reject');
}

/* ------------------------------------------------------------------ */
/* parseChatCompletion                                                 */
/* ------------------------------------------------------------------ */

describe('parseChatCompletion', () => {
	it('extracts text, finish reason, usage and model id', () => {
		const parsed = parseChatCompletion(completionBody());
		expect(parsed.text).toBe('Hello there');
		expect(parsed.finishReason).toBe('stop');
		expect(parsed.modelId).toBe('gpt-test-echo');
		expect(parsed.usage).toEqual<TokenUsage>({
			inputTokens: 12,
			outputTokens: 4,
			totalTokens: 16,
			estimated: false,
		});
	});

	it('tolerates missing usage', () => {
		const parsed = parseChatCompletion(completionBody({ usage: undefined }));
		expect(parsed.usage).toBeNull();
	});

	it('reads cached input tokens when reported', () => {
		const parsed = parseChatCompletion(
			completionBody({
				usage: {
					prompt_tokens: 100,
					completion_tokens: 10,
					total_tokens: 110,
					prompt_tokens_details: { cached_tokens: 80 },
				},
			}),
		);
		expect(parsed.usage?.cachedInputTokens).toBe(80);
		expect(parsed.usage?.estimated).toBe(false);
	});

	it('maps finish reasons onto the shared contract', () => {
		const cases: Array<[unknown, string]> = [
			['stop', 'stop'],
			['length', 'length'],
			['content_filter', 'content_filter'],
			['tool_calls', 'tool_calls'],
			['function_call', 'tool_calls'],
			['something_new', 'unknown'],
			[undefined, 'unknown'],
		];
		for (const [raw, expected] of cases) {
			const body = completionBody({
				choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: raw }],
			});
			expect(parseChatCompletion(body).finishReason).toBe(expected);
		}
	});

	it('joins array-of-parts content', () => {
		const parsed = parseChatCompletion(
			completionBody({
				choices: [
					{
						message: {
							content: [
								{ type: 'text', text: 'Hello ' },
								{ type: 'image_url', image_url: { url: 'x' } },
								{ type: 'text', text: 'world' },
							],
						},
						finish_reason: 'stop',
					},
				],
			}),
		);
		expect(parsed.text).toBe('Hello world');
	});

	it('accepts null content for tool-call payloads', () => {
		const parsed = parseChatCompletion(
			completionBody({
				choices: [
					{
						message: { content: null, tool_calls: [{ id: '1' }] },
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		expect(parsed.text).toBe('');
		expect(parsed.finishReason).toBe('tool_calls');
	});

	it('rejects malformed payloads with a non-retryable invalid-response error', () => {
		const malformed: unknown[] = [
			null,
			'not json object',
			{},
			{ choices: [] },
			{ choices: [null] },
			{ choices: [{}] },
			{ choices: [{ message: { content: 42 } }] },
		];
		for (const payload of malformed) {
			expect(() => parseChatCompletion(payload)).toThrow(ModelError);
			try {
				parseChatCompletion(payload);
			} catch (error) {
				expect((error as ModelError).kind).toBe('invalid-response');
				expect((error as ModelError).retryable).toBe(false);
			}
		}
	});
});

/* ------------------------------------------------------------------ */
/* Adapter request/response mapping                                    */
/* ------------------------------------------------------------------ */

describe('OpenAICompatibleAdapter', () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	it('exposes id, model id, context window and a token counter', () => {
		const { adapter } = makeAdapter(bodyResponse(200, completionBody()));
		expect(adapter.id).toBe('openai-chat');
		expect(adapter.modelId).toBe('gpt-test');
		expect(adapter.contextWindow).toBe(128_000);
		expect(adapter.tokenCounter.countMessages(makeRequest().messages)).toBeGreaterThan(0);
	});

	it('honours an explicit context window', () => {
		const transport = new FakeTransport(bodyResponse(200, completionBody()));
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://x.test',
			apiKey: '',
			modelId: 'm',
			contextWindow: 32_000,
			transport,
		});
		expect(adapter.contextWindow).toBe(32_000);
	});

	it('posts the expected OpenAI chat-completions request', async () => {
		const { adapter, transport } = makeAdapter(bodyResponse(200, completionBody()));
		const request = makeRequest();
		await adapter.complete(request);

		expect(transport.requests).toHaveLength(1);
		const sent = transport.requests[0];
		expect(sent?.url).toBe('https://api.example.test/v1/chat/completions');
		expect(sent?.headers['Content-Type']).toBe('application/json');
		expect(sent?.headers.Authorization).toBe('Bearer sk-test-key');
		expect(sent?.timeoutMs).toBe(5_000);
		expect(sent?.signal).toBe(request.signal);
		expect(sent?.body).toEqual({
			model: 'gpt-test',
			messages: request.messages,
			max_tokens: 128,
			temperature: 0.2,
			stream: false,
		});
	});

	it('trims a trailing slash from the base URL', async () => {
		const transport = new FakeTransport(bodyResponse(200, completionBody()));
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1/',
			apiKey: 'k',
			modelId: 'm',
			transport,
		});
		await adapter.complete(makeRequest());
		expect(transport.requests[0]?.url).toBe('https://api.example.test/v1/chat/completions');
	});

	it('omits the Authorization header when no API key is configured (local providers)', async () => {
		const transport = new FakeTransport(bodyResponse(200, completionBody()));
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'http://localhost:11434/v1',
			apiKey: '',
			modelId: 'llama',
			transport,
		});
		await adapter.complete(makeRequest());
		expect(transport.requests[0]?.headers.Authorization).toBeUndefined();
	});

	it('maps a successful payload onto ModelResponse', async () => {
		const { adapter } = makeAdapter(bodyResponse(200, completionBody()));
		const response = await adapter.complete(makeRequest());
		expect(response.text).toBe('Hello there');
		expect(response.finishReason).toBe('stop');
		expect(response.usage?.inputTokens).toBe(12);
		expect(response.usage?.estimated).toBe(false);
		expect(response.modelId).toBe('gpt-test-echo');
	});

	it('falls back to the configured model id when the provider omits it', async () => {
		const body = completionBody({ model: undefined });
		const { adapter } = makeAdapter(bodyResponse(200, body));
		const response = await adapter.complete(makeRequest());
		expect(response.modelId).toBe('gpt-test');
	});

	it('maps 401/403 to a non-retryable auth error', async () => {
		for (const status of [401, 403]) {
			const { adapter } = makeAdapter(bodyResponse(status, { error: { message: 'nope' } }));
			const error = await captureError(adapter.complete(makeRequest()));
			expect(error).toBeInstanceOf(ModelError);
			expect(error.kind).toBe('auth');
			expect(error.retryable).toBe(false);
			expect(error.status).toBe(status);
		}
	});

	it('maps 429 to rate-limit and 5xx to server', async () => {
		const rateLimited = await captureError(
			makeAdapter(bodyResponse(429, { error: { message: 'slow down' } })).adapter.complete(
				makeRequest(),
			),
		);
		expect(rateLimited.kind).toBe('rate-limit');
		expect(rateLimited.retryable).toBe(false);

		const server = await captureError(
			makeAdapter(bodyResponse(503, { error: { message: 'down' } })).adapter.complete(
				makeRequest(),
			),
		);
		expect(server.kind).toBe('server');
		expect(server.retryable).toBe(true);
		expect(server.status).toBe(503);
	});

	it('maps other 4xx statuses to invalid-response', async () => {
		const error = await captureError(
			makeAdapter(bodyResponse(400, { error: { message: 'bad model' } })).adapter.complete(
				makeRequest(),
			),
		);
		expect(error.kind).toBe('invalid-response');
		expect(error.message).toContain('HTTP 400');
		expect(error.message).toContain('bad model');
	});

	it('never includes the API key in error messages, even when the provider echoes it', async () => {
		const apiKey = 'sk-super-secret-123';
		const transport = new FakeTransport(
			bodyResponse(401, { error: { message: `invalid api key ${apiKey}` } }),
		);
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey,
			modelId: 'm',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.message).not.toContain(apiKey);
		expect(error.message).toContain('[redacted]');
	});

	it('maps a non-JSON success body to invalid-response', async () => {
		const transport = new FakeTransport(async () => ({ status: 200, text: '<html>oops</html>' }));
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey: 'k',
			modelId: 'm',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.kind).toBe('invalid-response');
	});

	it('maps a generic transport failure to network', async () => {
		const transport = new FakeTransport(async () => {
			throw new Error('socket hang up');
		});
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey: 'k',
			modelId: 'm',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.kind).toBe('network');
		expect(error.retryable).toBe(true);
	});

	it('propagates transport timeout errors', async () => {
		const transport = new FakeTransport(async () => {
			throw new ModelError('timeout', 'took too long');
		});
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey: 'k',
			modelId: 'm',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.kind).toBe('timeout');
	});

	it('propagates aborts from the transport', async () => {
		const transport = new FakeTransport(async () => {
			throw new ModelError('aborted', 'cancelled');
		});
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey: 'k',
			modelId: 'm',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.kind).toBe('aborted');
	});

	it('does not call the transport when the signal is already aborted', async () => {
		const { adapter, transport } = makeAdapter(bodyResponse(200, completionBody()));
		const controller = new AbortController();
		controller.abort();
		const error = await captureError(
			adapter.complete(makeRequest({ signal: controller.signal })),
		);
		expect(error.kind).toBe('aborted');
		expect(transport.requests).toHaveLength(0);
	});

	it('refuses to call a provider without a configured model id', async () => {
		const transport = new FakeTransport(bodyResponse(200, completionBody()));
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: 'https://api.example.test/v1',
			apiKey: 'k',
			modelId: '  ',
			transport,
		});
		const error = await captureError(adapter.complete(makeRequest()));
		expect(error.kind).toBe('configuration');
		expect(transport.requests).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------ */
/* createObsidianHttpTransport                                         */
/* ------------------------------------------------------------------ */

describe('createObsidianHttpTransport', () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('posts JSON through requestUrl with throw:false and without an Authorization leak', async () => {
		requestUrlMock.mockResolvedValue({ status: 200, text: '{"ok":true}' });
		const transport = createObsidianHttpTransport(testTimers);
		const controller = new AbortController();
		const response = await transport.post({
			url: 'https://api.example.test/v1/chat/completions',
			headers: { Authorization: 'Bearer sk-abc' },
			body: { model: 'm' },
			signal: controller.signal,
			timeoutMs: 1_000,
		});
		expect(response).toEqual({ status: 200, text: '{"ok":true}' });
		const sent = requestUrlMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sent.method).toBe('POST');
		expect(sent.url).toBe('https://api.example.test/v1/chat/completions');
		expect(sent.body).toBe(JSON.stringify({ model: 'm' }));
		expect(sent.throw).toBe(false);
	});

	it('rejects with a timeout ModelError when the request outlives timeoutMs', async () => {
		vi.useFakeTimers();
		requestUrlMock.mockReturnValue(new Promise(() => {}));
		const transport = createObsidianHttpTransport(testTimers);
		const controller = new AbortController();
		const pending = captureError(
			transport.post({
				url: 'https://api.example.test/v1/chat/completions',
				headers: {},
				body: {},
				signal: controller.signal,
				timeoutMs: 25,
			}),
		);
		await vi.advanceTimersByTimeAsync(30);
		expect((await pending).kind).toBe('timeout');
	});

	it('rejects with an aborted ModelError when the signal aborts mid-flight', async () => {
		vi.useFakeTimers();
		requestUrlMock.mockReturnValue(new Promise(() => {}));
		const transport = createObsidianHttpTransport(testTimers);
		const controller = new AbortController();
		const pending = captureError(
			transport.post({
				url: 'https://api.example.test/v1/chat/completions',
				headers: {},
				body: {},
				signal: controller.signal,
				timeoutMs: 5_000,
			}),
		);
		controller.abort();
		expect((await pending).kind).toBe('aborted');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('maps a requestUrl rejection to a retryable network error', async () => {
		requestUrlMock.mockRejectedValue(new Error('offline'));
		const transport = createObsidianHttpTransport(testTimers);
		const controller = new AbortController();
		await expect(
			transport.post({
				url: 'https://api.example.test/v1/chat/completions',
				headers: {},
				body: {},
				signal: controller.signal,
				timeoutMs: 1_000,
			}),
		).rejects.toMatchObject({ kind: 'network', retryable: true });
	});
});
