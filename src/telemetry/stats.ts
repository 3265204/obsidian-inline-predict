/**
 * Local-only statistics.
 *
 * Nothing here is ever sent anywhere (AGENTS.md non-goal: no telemetry upload). The counters back
 * the diagnostics panel and the KPI table in docs/GOALS.md, so they are deliberately explicit
 * about estimated vs provider-reported usage: a request may complete with `usage === null`, in
 * which case token counters simply do not move.
 */

import type {
	CandidateSource,
	CompletionCandidate,
	DiagnosticsSnapshot,
	LatencySummary,
	ModelCallRecord,
	PredictionSkipReason,
	TokenUsage,
} from '../core/types';
import { LATENCY_WINDOW, PROVIDER_PRICE_UNKNOWN } from '../core/constants';

/** Price per 1M tokens. Only set when the user configured it; never guessed. */
export interface PricingConfig {
	inputPerMillion: number;
	outputPerMillion: number;
}

export interface RequestTelemetry {
	startedAt: number;
	latencyMs: number;
	usage: TokenUsage | null;
	candidate: CompletionCandidate | null;
	modelCalls?: readonly ModelCallRecord[];
	reason?: PredictionSkipReason | null;
}

export interface FailureTelemetry {
	latencyMs: number;
	estimatedTokens?: number;
}

/** Derived rates/aggregates that do not fit the raw `DiagnosticsSnapshot` contract. */
export interface TelemetryMetrics {
	/** cacheHits / candidatesShown. Null until a candidate was shown. */
	cacheHitRate: number | null;
	/** 至少被接受过一次的候选数 / 展示过的候选数。 */
	acceptRate: number | null;
	/** partialAccepts / (fullAccepts + partialAccepts). */
	partialAcceptRate: number | null;
	/** fullAccepts / (fullAccepts + partialAccepts). */
	fullAcceptRate: number | null;
	/** rejects / candidatesShown. */
	rejectRate: number | null;
	ignoreRate: number | null;
	/** (inputTokens + outputTokens) / accepted suggestions. Aggregate attribution. */
	tokensPerAcceptedSuggestion: number | null;
	/** 实际模型调用数 / 至少被接受过一次的候选数。 */
	requestsPerAcceptedSuggestion: number | null;
	providerUsageRequests: number;
	estimatedUsageRequests: number;
	estimatedUsageShare: number | null;
	latency: LatencySummary;
	estimatedCostUsd: number | null;
}

/** Nearest-rank percentile over an already sorted ascending array. */
function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return numerator / denominator;
}

function roundCost(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

export class Telemetry {
	private readonly now: () => number;
	private startedAt: number;
	private requests = 0;
	private modelCalls = 0;
	private modelCallFailures = 0;
	private unknownUsageCalls = 0;
	private acceptedSuggestions = 0;
	private shownIds = new Set<string>();
	private acceptedIds = new Set<string>();
	private requestFailures = 0;
	private candidatesShown = 0;
	private cacheHits = 0;
	private prefixReuses = 0;
	private offTopicRejections = 0;
	private fullAccepts = 0;
	private partialAccepts = 0;
	private rejects = 0;
	private ignored = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private cachedInputTokens = 0;
	private estimatedUsageRequests = 0;
	private providerUsageRequests = 0;
	private estimatedFailureTokens = 0;
	private lastRequestStartedAt: number | null = null;
	/** Bounded window: oldest first, trimmed to LATENCY_WINDOW on insert. */
	private latencies: number[] = [];
	private pricing: PricingConfig | typeof PROVIDER_PRICE_UNKNOWN = PROVIDER_PRICE_UNKNOWN;

	constructor(options: { now?: () => number; startedAt?: number } = {}) {
		this.now = options.now ?? (() => Date.now());
		this.startedAt = options.startedAt ?? this.now();
	}

	/** 逻辑预测与实际调用分别计数。用量未知的调用保留为未知，不按零消耗处理。 */
	recordRequest(record: RequestTelemetry): void {
		if (record.modelCalls?.length === 0 && (record.reason === 'no-model' || record.reason === 'budget-exceeded')) return;
		this.requests++;
		this.lastRequestStartedAt = record.startedAt;
		if (!['error', 'timeout', 'rate-limited', 'aborted'].includes(record.reason ?? '')) this.pushLatency(record.latencyMs);
		const calls = record.modelCalls ?? [{ usage: record.usage, failed: false }];
		for (const call of calls) {
			this.modelCalls++;
			if (call.failed) this.modelCallFailures++;
			const usage = call.usage;
			if (usage === null) { this.unknownUsageCalls++; continue; }
			this.inputTokens += Math.max(0, usage.inputTokens);
			this.outputTokens += Math.max(0, usage.outputTokens);
			this.cachedInputTokens += Math.max(0, usage.cachedInputTokens ?? 0);
			if (usage.estimated) this.estimatedUsageRequests++;
			else this.providerUsageRequests++;
		}
	}

	/** A failed request. Failure latency is tracked separately from the success window. */
	recordFailure(record: FailureTelemetry): void {
		this.requestFailures++;
		this.estimatedFailureTokens += Math.max(0, record.estimatedTokens ?? 0);
	}

	recordCandidateShown(source: CandidateSource, identity?: string): void {
		if (source !== 'prefix-reuse' && this.remember(this.shownIds, identity)) this.candidatesShown++;
		if (source === 'cache') this.cacheHits++;
		if (source === 'prefix-reuse') this.prefixReuses++;
	}

	/** A candidate was discarded by the local relatedness filter (no user-visible suggestion). */
	recordOffTopic(): void {
		this.offTopicRejections++;
	}

	recordAccept(full: boolean, identity?: string): void {
		if (this.remember(this.acceptedIds, identity)) this.acceptedSuggestions++;
		if (full) this.fullAccepts++;
		else this.partialAccepts++;
	}

	recordReject(): void {
		this.rejects++;
	}

	recordIgnored(): void {
		this.ignored++;
	}

	/** Configure cost estimation. Passing null disables it (`estimatedCostUsd` becomes null). */
	setPricing(pricing: PricingConfig | null): void {
		this.pricing = pricing;
	}

	snapshot(): DiagnosticsSnapshot {
		return {
			startedAt: this.startedAt,
			requests: this.requests,
			modelCalls: this.modelCalls,
			modelCallFailures: this.modelCallFailures,
			unknownUsageCalls: this.unknownUsageCalls,
			providerUsageCalls: this.providerUsageRequests,
			acceptedSuggestions: this.acceptedSuggestions,
			requestFailures: this.requestFailures,
			candidatesShown: this.candidatesShown,
			cacheHits: this.cacheHits,
			prefixReuses: this.prefixReuses,
			offTopicRejections: this.offTopicRejections,
			fullAccepts: this.fullAccepts,
			partialAccepts: this.partialAccepts,
			rejects: this.rejects,
			ignored: this.ignored,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cachedInputTokens: this.cachedInputTokens,
			estimatedUsageRequests: this.estimatedUsageRequests,
			latency: this.latencySummary(),
			estimatedCostUsd: this.estimatedCost(),
		};
	}

	/** Derived KPI-facing numbers. */
	metrics(): TelemetryMetrics {
		const accepted = this.fullAccepts + this.partialAccepts;
		const decisions = accepted + this.rejects;
		const tokens = this.inputTokens + this.outputTokens;
		const usageRequests = this.estimatedUsageRequests + this.providerUsageRequests;
		return {
			cacheHitRate: ratio(this.cacheHits, this.candidatesShown),
			acceptRate: ratio(this.acceptedSuggestions, this.candidatesShown),
			partialAcceptRate: ratio(this.partialAccepts, accepted),
			fullAcceptRate: ratio(this.fullAccepts, accepted),
			rejectRate: ratio(this.rejects, this.candidatesShown),
			ignoreRate: ratio(this.ignored, this.candidatesShown),
			tokensPerAcceptedSuggestion: ratio(tokens, this.acceptedSuggestions),
			requestsPerAcceptedSuggestion: ratio(this.modelCalls, this.acceptedSuggestions),
			providerUsageRequests: this.providerUsageRequests,
			estimatedUsageRequests: this.estimatedUsageRequests,
			estimatedUsageShare: ratio(this.estimatedUsageRequests, usageRequests),
			latency: this.latencySummary(),
			estimatedCostUsd: this.estimatedCost(),
		};
	}

	/** Total estimated tokens of failures (diagnostics only). */
	get estimatedTokensOfFailures(): number {
		return this.estimatedFailureTokens;
	}

	/** Last request start timestamp; useful to correlate a shown candidate with a request. */
	get lastRequestAt(): number | null {
		return this.lastRequestStartedAt;
	}

	reset(): void {
		this.startedAt = this.now();
		this.requests = 0;
		this.modelCalls = 0;
		this.modelCallFailures = 0;
		this.unknownUsageCalls = 0;
		this.acceptedSuggestions = 0;
		this.shownIds.clear();
		this.acceptedIds.clear();
		this.requestFailures = 0;
		this.candidatesShown = 0;
		this.cacheHits = 0;
		this.prefixReuses = 0;
		this.offTopicRejections = 0;
		this.fullAccepts = 0;
		this.partialAccepts = 0;
		this.rejects = 0;
		this.ignored = 0;
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.cachedInputTokens = 0;
		this.estimatedUsageRequests = 0;
		this.providerUsageRequests = 0;
		this.estimatedFailureTokens = 0;
		this.lastRequestStartedAt = null;
		this.latencies = [];
		// pricing is configuration, not stats: keep it across a reset.
	}

	private pushLatency(latencyMs: number): void {
		if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
		this.latencies.push(latencyMs);
		if (this.latencies.length > LATENCY_WINDOW) {
			this.latencies.splice(0, this.latencies.length - LATENCY_WINDOW);
		}
	}

	private remember(ids: Set<string>, identity?: string): boolean {
		if (identity === undefined) return true;
		if (ids.has(identity)) return false;
		ids.add(identity);
		// 只保留近期候选标识，避免诊断数据随写作时长无限增长。
		if (ids.size > 2048) {
			const oldest = ids.values().next().value;
			if (oldest !== undefined) ids.delete(oldest);
		}
		return true;
	}

	/** p50/p95/mean over the bounded success-latency window. */
	latencySummary(): LatencySummary {
		const window = this.latencies;
		if (window.length === 0) return { count: 0, p50: 0, p95: 0, mean: 0 };
		const sorted = [...window].sort((a, b) => a - b);
		let sum = 0;
		for (const value of sorted) sum += value;
		return {
			count: sorted.length,
			p50: percentile(sorted, 50),
			p95: percentile(sorted, 95),
			mean: sum / sorted.length,
		};
	}

	private estimatedCost(): number | null {
		if (this.pricing === null || this.unknownUsageCalls > 0) return null;
		const inputCost = (this.inputTokens / 1_000_000) * this.pricing.inputPerMillion;
		const outputCost = (this.outputTokens / 1_000_000) * this.pricing.outputPerMillion;
		return roundCost(inputCost + outputCost);
	}
}
