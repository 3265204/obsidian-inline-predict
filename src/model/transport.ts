/**
 * HTTP transport seam for the OpenAI-compatible adapter.
 *
 * `requestUrl` is the only network primitive a community plugin may use: it bypasses CORS on
 * desktop and mobile and does not require a Node HTTP stack. It cannot be cancelled, so abort
 * and timeout are implemented at the promise boundary — the wrapper rejects immediately and any
 * later response is ignored. That is enough because the caller has already discarded the
 * request by then.
 *
 * This module is the only model-side file allowed to import `obsidian`; tests inject a fake
 * `HttpTransport` and never exercise `createObsidianHttpTransport`.
 */
import { requestUrl } from 'obsidian';
import { ModelError, type TimerScheduler } from '../core/types';
import { createWindowTimers } from '../core/timers';

export interface HttpRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	signal: AbortSignal;
	timeoutMs: number;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export interface HttpTransport {
	post(request: HttpRequest): Promise<HttpResponse>;
}

export function createObsidianHttpTransport(timers?: TimerScheduler): HttpTransport {
	return {
		post(request: HttpRequest): Promise<HttpResponse> {
			return new Promise<HttpResponse>((resolve, reject) => {
				if (request.signal.aborted) {
					reject(new ModelError('aborted', 'Request was aborted before it started'));
					return;
				}

				let settled = false;
				let cancelTimeout: (() => void) | null = null;

				function finish(complete: () => void): void {
					if (settled) return;
					settled = true;
					cancelTimeout?.();
					request.signal.removeEventListener('abort', onAbort);
					complete();
				}

				function onAbort(): void {
					finish(() => reject(new ModelError('aborted', 'Request was aborted')));
				}

				if (request.timeoutMs > 0) {
					cancelTimeout = (timers ?? createWindowTimers(window)).schedule(() => {
						finish(
							() =>
								reject(
									new ModelError(
										'timeout',
										`Request timed out after ${request.timeoutMs} ms`,
									),
								),
						);
					}, request.timeoutMs);
				}
				request.signal.addEventListener('abort', onAbort, { once: true });

				void requestUrl({
					url: request.url,
					method: 'POST',
					contentType: 'application/json',
					headers: request.headers,
					body: JSON.stringify(request.body),
					throw: false,
				})
					.then((response) => {
						finish(() => resolve({ status: response.status, text: response.text }));
					})
					.catch((cause: unknown) => {
						finish(() =>
							reject(
								new ModelError('network', 'Network request failed', {
									cause,
									retryable: true,
								}),
							),
						);
					});
			});
		},
	};
}
