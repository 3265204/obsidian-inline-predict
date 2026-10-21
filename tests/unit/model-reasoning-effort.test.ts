/**
 * Provider-specific `reasoning_effort` handling.
 *
 * DeepSeek V4 Flash defaults to internal reasoning, which consumes the output budget and ruins
 * inline prediction latency. The adapter must forward the parameter only when explicitly set,
 * and must never send an empty string (some OpenAI-compatible servers reject unknown fields).
 */

import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/model/openai-chat';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/model/transport';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/settings/schema';

class CapturingTransport implements HttpTransport {
	readonly requests: HttpRequest[] = [];

	async post(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		return {
			status: 200,
			text: JSON.stringify({
				choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
				model: 'deepseek-flash',
			}),
		};
	}
}

function requestBody(transport: CapturingTransport): Record<string, unknown> {
	const request = transport.requests[0];
	expect(request).toBeDefined();
	return request?.body as Record<string, unknown>;
}

function makeAdapter(transport: CapturingTransport, reasoningEffort?: string) {
	return new OpenAICompatibleAdapter({
		baseUrl: 'https://api.deepseek.com/v1',
		apiKey: 'test-key',
		modelId: 'deepseek-flash',
		reasoningEffort,
		transport,
	});
}

const modelRequest = {
	messages: [
		{ role: 'system' as const, content: 'system' },
		{ role: 'user' as const, content: 'user' },
	],
	maxOutputTokens: 64,
	temperature: 0.2,
	signal: new AbortController().signal,
	timeoutMs: 1_000,
	requestId: 1,
};

describe('reasoning_effort', () => {
	it('forwards the configured value', async () => {
		const transport = new CapturingTransport();
		await makeAdapter(transport, 'none').complete(modelRequest);
		expect(requestBody(transport).reasoning_effort).toBe('none');
	});

	it('trims whitespace', async () => {
		const transport = new CapturingTransport();
		await makeAdapter(transport, '  low  ').complete(modelRequest);
		expect(requestBody(transport).reasoning_effort).toBe('low');
	});

	it('omits the parameter when unset or empty', async () => {
		const unset = new CapturingTransport();
		await makeAdapter(unset).complete(modelRequest);
		expect('reasoning_effort' in requestBody(unset)).toBe(false);

		const empty = new CapturingTransport();
		await makeAdapter(empty, '   ').complete(modelRequest);
		expect('reasoning_effort' in requestBody(empty)).toBe(false);
	});

	it('defaults to omitted in settings and preserves an explicit value', () => {
		expect(DEFAULT_SETTINGS.provider.reasoningEffort).toBe('');
		expect(normalizeSettings(undefined).provider.reasoningEffort).toBe('');
		expect(
			normalizeSettings({ provider: { reasoningEffort: ' none ' } }).provider.reasoningEffort,
		).toBe('none');
	});
});
