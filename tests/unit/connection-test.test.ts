/**
 * "Test connection" sends a fixed ping completion and maps failures to a result the settings UI
 * can localize. It must never include note text and must never be recorded as prediction usage.
 */

import { describe, expect, it } from 'vitest';
import { ModelError } from '../../src/core/types';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../../src/core/types';
import { testModelConnection } from '../../src/model/connection-test';

class FakeAdapter implements ModelAdapter {
	readonly id = 'fake';
	readonly modelId = 'fake-model';
	readonly contextWindow = 8_192;
	readonly calls: ModelRequest[] = [];

	constructor(private readonly outcome: ModelResponse | Error) {}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.calls.push(request);
		if (this.outcome instanceof Error) throw this.outcome;
		return this.outcome;
	}
}

function okResponse(): ModelResponse {
	return {
		text: 'OK',
		finishReason: 'stop',
		usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13, estimated: false },
		modelId: 'fake-model',
	};
}

describe('testModelConnection', () => {
	it('reports success with the measured latency and sends no note text', async () => {
		const adapter = new FakeAdapter(okResponse());
		let clock = 1_000;
		const result = await testModelConnection(adapter, { now: () => (clock += 250) });
		expect(result).toEqual({ ok: true, latencyMs: 250 });
		expect(adapter.calls).toHaveLength(1);
		const call = adapter.calls[0];
		expect(call?.maxOutputTokens).toBe(8);
		expect(call?.temperature).toBe(0);
		expect(call?.messages).toHaveLength(2);
		expect(call?.messages[1]?.content).toBe('ping');
	});

	it('maps provider errors to a kind the UI can localize', async () => {
		const auth = await testModelConnection(
			new FakeAdapter(new ModelError('auth', 'bad key', { status: 401 })),
		);
		expect(auth.ok).toBe(false);
		expect(auth.errorKind).toBe('auth');

		const timeout = await testModelConnection(
			new FakeAdapter(new ModelError('timeout', 'too slow')),
		);
		expect(timeout.ok).toBe(false);
		expect(timeout.errorKind).toBe('timeout');

		const network = await testModelConnection(new FakeAdapter(new Error('offline')));
		expect(network.ok).toBe(false);
		expect(network.errorKind).toBe('network');
	});

	it('never throws, even for an aborted or malformed provider', async () => {
		const result = await testModelConnection(
			new FakeAdapter(new ModelError('invalid-response', 'no choices')),
		);
		expect(result.ok).toBe(false);
		expect(result.errorKind).toBe('invalid-response');
	});
});
