/**
 * OpenAI-compatible chat adapter (non-streaming).
 *
 * The plugin supports any provider that speaks the `/chat/completions` shape. The adapter is
 * deliberately thin: build one request, map transport/HTTP failures onto `ModelError` kinds,
 * normalize `finish_reason` and usage, and never retry (the scheduler owns backoff).
 *
 * It never logs or embeds the API key in an error message; provider error bodies are truncated
 * and redacted before they surface.
 */
import {
	ModelError,
	type ChatTokenCounter,
	type FinishReason,
	type ModelAdapter,
	type ModelRequest,
	type ModelResponse,
	type TokenUsage,
} from '../core/types';
import { sanitizeControlCharacters } from '../core/text';
import { heuristicTokenCounter } from '../tokens/estimator';
import { createObsidianHttpTransport, type HttpResponse, type HttpTransport } from './transport';

export interface OpenAICompatibleOptions {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	contextWindow?: number;
	temperature?: number;
	maxOutputTokens?: number;
	timeoutMs?: number;
	transport?: HttpTransport;
	/** Omitted from the request body when empty/undefined. */
	reasoningEffort?: string;
}

export interface ParsedChatCompletion {
	text: string;
	finishReason: FinishReason;
	usage: TokenUsage | null;
	modelId: string;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_MESSAGE_CHARS = 200;

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapFinishReason(raw: unknown): FinishReason {
	switch (raw) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'content_filter':
			return 'content_filter';
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls';
		default:
			return 'unknown';
	}
}

function readContent(content: unknown): string {
	if (content === undefined || content === null) return '';
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) {
		throw new ModelError('invalid-response', 'Chat completion content has an unsupported shape');
	}
	const parts: string[] = [];
	for (const part of content) {
		const record = asRecord(part);
		if (!record) continue;
		if (typeof record.text === 'string') parts.push(record.text);
	}
	return parts.join('');
}

function parseUsage(raw: unknown): TokenUsage | null {
	const usage = asRecord(raw);
	if (!usage) return null;
	const prompt = readNumber(usage.prompt_tokens);
	const completion = readNumber(usage.completion_tokens);
	const total = readNumber(usage.total_tokens);
	if (prompt === null && completion === null && total === null) return null;
	const inputTokens = prompt ?? 0;
	const outputTokens = completion ?? 0;
	const result: TokenUsage = {
		inputTokens,
		outputTokens,
		totalTokens: total ?? inputTokens + outputTokens,
		estimated: false,
	};
	const details = asRecord(usage.prompt_tokens_details);
	const cached = readNumber(details?.cached_tokens);
	if (cached !== null && cached > 0) result.cachedInputTokens = cached;
	return result;
}

/**
 * Normalize a provider payload. Tolerates a missing `usage`, string or parts-array content and
 * unknown finish reasons; throws `ModelError('invalid-response')` when the envelope itself is
 * unusable.
 */
export function parseChatCompletion(raw: unknown): ParsedChatCompletion {
	const payload = asRecord(raw);
	if (!payload) throw new ModelError('invalid-response', 'Chat completion payload is not an object');
	const choices = payload.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new ModelError('invalid-response', 'Chat completion payload has no choices');
	}
	const choice = asRecord(choices[0]);
	if (!choice) throw new ModelError('invalid-response', 'Chat completion choice is not an object');

	let text: string;
	const message = asRecord(choice.message);
	if (message) {
		text = readContent(message.content);
	} else if (typeof choice.text === 'string') {
		// Legacy `/completions`-shaped payloads are accepted so proxies keep working.
		text = choice.text;
	} else {
		throw new ModelError('invalid-response', 'Chat completion choice has no message');
	}

	return {
		text,
		finishReason: mapFinishReason(choice.finish_reason),
		usage: parseUsage(payload.usage),
		modelId: typeof payload.model === 'string' ? payload.model : '',
	};
}

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

function extractProviderMessage(text: string, apiKey: string): string | null {
	let message: string | null = null;
	try {
		const payload = asRecord(JSON.parse(text));
		const error = asRecord(payload?.error);
		if (typeof error?.message === 'string') message = error.message;
	} catch {
		message = null;
	}
	if (message === null) return null;
	const withoutControl = sanitizeControlCharacters(message, false, ' ').trim();
	const redacted = apiKey.length > 0 ? withoutControl.split(apiKey).join('[redacted]') : withoutControl;
	if (redacted.length === 0) return null;
	return redacted.length > MAX_PROVIDER_MESSAGE_CHARS
		? `${redacted.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}…`
		: redacted;
}

function statusError(response: HttpResponse, apiKey: string): ModelError {
	const detail = extractProviderMessage(response.text, apiKey);
	const suffix = detail === null ? '' : `: ${detail}`;
	const message = `Provider returned HTTP ${response.status}${suffix}`;
	if (response.status === 401 || response.status === 403) {
		return new ModelError('auth', message, { status: response.status, retryable: false });
	}
	if (response.status === 429) {
		return new ModelError('rate-limit', message, { status: response.status, retryable: false });
	}
	if (response.status >= 500) {
		return new ModelError('server', message, { status: response.status, retryable: true });
	}
	return new ModelError('invalid-response', message, { status: response.status, retryable: false });
}

function normalizeTransportError(error: unknown, signal: AbortSignal): ModelError {
	if (signal.aborted) {
		return new ModelError('aborted', 'Request was aborted', { cause: error });
	}
	if (error instanceof ModelError) return error;
	return new ModelError('network', 'Network request failed', { cause: error, retryable: true });
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class OpenAICompatibleAdapter implements ModelAdapter {
	readonly id = 'openai-chat';
	readonly modelId: string;
	readonly contextWindow: number;
	readonly tokenCounter: ChatTokenCounter;

	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly transport: HttpTransport;
	private readonly temperature: number;
	private readonly maxOutputTokens: number;
	private readonly timeoutMs: number;
	private readonly reasoningEffort: string;

	constructor(options: OpenAICompatibleOptions) {
		this.modelId = options.modelId;
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.apiKey = options.apiKey;
		this.transport = options.transport ?? createObsidianHttpTransport();
		this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
		this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		this.reasoningEffort = (options.reasoningEffort ?? '').trim();
		this.tokenCounter = heuristicTokenCounter;
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		if (this.modelId.trim().length === 0) {
			throw new ModelError('configuration', 'No model id is configured');
		}
		if (request.signal.aborted) {
			throw new ModelError('aborted', 'Request was aborted before it started');
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const apiKey = this.apiKey.trim();
		if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;

		// Request values win; the adapter options are fallbacks for callers that only pass
		// partial requests (the scheduler always fills them in).
		const maxOutputTokens =
			request.maxOutputTokens > 0 ? request.maxOutputTokens : this.maxOutputTokens;
		const temperature = Number.isFinite(request.temperature)
			? request.temperature
			: this.temperature;

		const body: Record<string, unknown> = {
			model: this.modelId,
			messages: request.messages.map((message) => ({
				role: message.role,
				content: message.content,
			})),
			max_tokens: maxOutputTokens,
			temperature,
			stream: false,
		};
		// Some OpenAI-compatible providers reject unknown parameters; only send it when configured.
		if (this.reasoningEffort.length > 0) body.reasoning_effort = this.reasoningEffort;

		let response: HttpResponse;
		try {
			response = await this.transport.post({
				url: `${this.baseUrl}/chat/completions`,
				headers,
				body,
				signal: request.signal,
				timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : this.timeoutMs,
			});
		} catch (error) {
			throw normalizeTransportError(error, request.signal);
		}
		if (request.signal.aborted) throw new ModelError('aborted', 'Request was aborted');

		if (response.status < 200 || response.status >= 300) {
			throw statusError(response, apiKey);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(response.text);
		} catch (cause) {
			throw new ModelError('invalid-response', 'Provider response was not valid JSON', {
				status: response.status,
				cause,
			});
		}
		const parsed = parseChatCompletion(payload);
		return {
			text: parsed.text,
			finishReason: parsed.finishReason,
			usage: parsed.usage,
			modelId: parsed.modelId.length > 0 ? parsed.modelId : this.modelId,
			raw: payload,
		};
	}
}
