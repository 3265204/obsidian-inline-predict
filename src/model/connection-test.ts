/**
 * "Test connection" for the model settings.
 *
 * The only reliable check across OpenAI-compatible providers is the operation we actually use:
 * a tiny non-streaming chat completion. `/models` is not implemented everywhere, so a 2xx
 * completion response (any content, any finish reason) means URL + key + model are reachable.
 *
 * The request carries no note text (a fixed "ping" message), is capped to a few output tokens and
 * a short timeout, and is not recorded in prediction statistics.
 */

import { ModelError } from '../core/types';
import type { ModelAdapter, ModelErrorKind } from '../core/types';

export interface ConnectionTestOptions {
	timeoutMs?: number;
	now?: () => number;
}

export interface ConnectionTestResult {
	ok: boolean;
	latencyMs: number;
	/** Present when `ok` is false. */
	errorKind?: ModelErrorKind;
	/** Provider message (already redacted by the adapter). */
	message?: string;
}

export async function testModelConnection(
	adapter: ModelAdapter,
	options: ConnectionTestOptions = {},
): Promise<ConnectionTestResult> {
	const now = options.now ?? (() => Date.now());
	const startedAt = now();
	const controller = new AbortController();
	try {
		await adapter.complete({
			messages: [
				{ role: 'system', content: 'Reply with the single word OK.' },
				{ role: 'user', content: 'ping' },
			],
			maxOutputTokens: 8,
			temperature: 0,
			signal: controller.signal,
			timeoutMs: options.timeoutMs ?? 8_000,
			requestId: 0,
		});
		return { ok: true, latencyMs: Math.max(0, now() - startedAt) };
	} catch (error) {
		const latencyMs = Math.max(0, now() - startedAt);
		if (error instanceof ModelError) {
			return { ok: false, latencyMs, errorKind: error.kind, message: error.message };
		}
		return {
			ok: false,
			latencyMs,
			errorKind: 'network',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
