import { describe, expect, it } from 'vitest';
import { Telemetry } from '../../src/telemetry/stats';
import type { CompletionCandidate, TokenUsage } from '../../src/core/types';
import { LATENCY_WINDOW } from '../../src/core/constants';

function usage(inputTokens: number, outputTokens: number, estimated = false): TokenUsage {
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated };
}

function candidate(requestId = 1): CompletionCandidate {
	return {
		requestId,
		text: 'hello',
		docId: 'notes/test.md',
		docVersion: 1,
		anchor: 0,
		finishReason: 'stop',
		usage: null,
		modelId: 'fake',
		createdAt: 0,
		latencyMs: 10,
		source: 'model',
		degraded: false,
	};
}

function record(
	telemetry: Telemetry,
	latencyMs: number,
	tokens: TokenUsage | null = usage(100, 20),
	shownCandidate: CompletionCandidate | null = null,
): void {
	telemetry.recordRequest({ startedAt: 0, latencyMs, usage: tokens, candidate: shownCandidate });
}

describe('Telemetry counters', () => {
	it('重复展示和多次部分接受只计一个候选和一次采纳', () => {
		const stats = new Telemetry();
		stats.recordCandidateShown('model', 'one');
		stats.recordCandidateShown('prefix-reuse', 'one');
		stats.recordCandidateShown('cache', 'one');
		stats.recordAccept(false, 'one');
		stats.recordAccept(false, 'one');
		stats.recordAccept(true, 'one');
		expect(stats.snapshot()).toMatchObject({ candidatesShown: 1, acceptedSuggestions: 1, prefixReuses: 1 });
		expect(stats.metrics().acceptRate).toBe(1);
	});

	it('用量未知时不展示可能低估的总费用', () => {
		const stats = new Telemetry();
		stats.setPricing({ inputPerMillion: 1, outputPerMillion: 1 });
		stats.recordRequest({ startedAt: 0, latencyMs: 1, candidate: null, usage: null,
			modelCalls: [{ usage: null, failed: true }] });
		expect(stats.snapshot().unknownUsageCalls).toBe(1);
		expect(stats.snapshot().estimatedCostUsd).toBeNull();
	});
	it('starts empty', () => {
		const telemetry = new Telemetry({ startedAt: 1234 });
		const snapshot = telemetry.snapshot();
		expect(snapshot.startedAt).toBe(1234);
		expect(snapshot.requests).toBe(0);
		expect(snapshot.candidatesShown).toBe(0);
		expect(snapshot.latency).toEqual({ count: 0, p50: 0, p95: 0, mean: 0 });
		expect(snapshot.estimatedCostUsd).toBeNull();
		expect(telemetry.metrics().acceptRate).toBeNull();
	});

	it('records requests, usage and estimated vs provider counters', () => {
		const telemetry = new Telemetry();
		record(telemetry, 100, usage(100, 20, true));
		record(telemetry, 200, usage(300, 40, false));
		record(telemetry, 300, null);
		const snapshot = telemetry.snapshot();
		expect(snapshot.requests).toBe(3);
		expect(snapshot.inputTokens).toBe(400);
		expect(snapshot.outputTokens).toBe(60);
		expect(snapshot.estimatedUsageRequests).toBe(1);
		const metrics = telemetry.metrics();
		expect(metrics.providerUsageRequests).toBe(1);
		expect(metrics.estimatedUsageRequests).toBe(1);
		expect(metrics.estimatedUsageShare).toBe(0.5);
	});

	it('counts cache hits, prefix reuses and shown candidates', () => {
		const telemetry = new Telemetry();
		telemetry.recordCandidateShown('model');
		telemetry.recordCandidateShown('cache');
		telemetry.recordCandidateShown('cache');
		telemetry.recordCandidateShown('prefix-reuse');
		const snapshot = telemetry.snapshot();
		expect(snapshot.candidatesShown).toBe(3);
		expect(snapshot.cacheHits).toBe(2);
		expect(snapshot.prefixReuses).toBe(1);
		expect(telemetry.metrics().cacheHitRate).toBeCloseTo(2 / 3);
	});

	it('counts suggestions rejected by the off-topic filter', () => {
		const telemetry = new Telemetry();
		telemetry.recordOffTopic();
		telemetry.recordOffTopic();
		expect(telemetry.snapshot().offTopicRejections).toBe(2);
		telemetry.reset();
		expect(telemetry.snapshot().offTopicRejections).toBe(0);
	});

	it('counts accepts, partial accepts, rejects and ignores', () => {
		const telemetry = new Telemetry();
		for (let i = 0; i < 10; i++) telemetry.recordCandidateShown('model');
		telemetry.recordAccept(true);
		telemetry.recordAccept(true);
		telemetry.recordAccept(false);
		telemetry.recordReject();
		telemetry.recordIgnored();
		const snapshot = telemetry.snapshot();
		expect(snapshot.fullAccepts).toBe(2);
		expect(snapshot.partialAccepts).toBe(1);
		expect(snapshot.rejects).toBe(1);
		expect(snapshot.ignored).toBe(1);
		const metrics = telemetry.metrics();
		expect(metrics.acceptRate).toBeCloseTo(0.3);
		expect(metrics.fullAcceptRate).toBeCloseTo(2 / 3);
		expect(metrics.partialAcceptRate).toBeCloseTo(1 / 3);
		expect(metrics.rejectRate).toBeCloseTo(0.1);
		expect(metrics.ignoreRate).toBeCloseTo(0.1);
	});

	it('attributes tokens per accepted suggestion and per request', () => {
		const telemetry = new Telemetry();
		record(telemetry, 100, usage(100, 20));
		record(telemetry, 100, usage(200, 40));
		telemetry.recordCandidateShown('model');
		telemetry.recordCandidateShown('model');
		telemetry.recordAccept(true);
		telemetry.recordAccept(false);
		const metrics = telemetry.metrics();
		expect(metrics.tokensPerAcceptedSuggestion).toBe(180);
		expect(metrics.requestsPerAcceptedSuggestion).toBe(1);
	});

	it('records failures separately from successful latency', () => {
		const telemetry = new Telemetry();
		record(telemetry, 100);
		telemetry.recordFailure({ latencyMs: 9000, estimatedTokens: 321 });
		telemetry.recordFailure({ latencyMs: 8000 });
		const snapshot = telemetry.snapshot();
		expect(snapshot.requestFailures).toBe(2);
		expect(snapshot.latency.count).toBe(1);
		expect(telemetry.estimatedTokensOfFailures).toBe(321);
	});
});

describe('Telemetry latency window', () => {
	it('computes nearest-rank p50/p95/mean', () => {
		const telemetry = new Telemetry();
		for (let latency = 1; latency <= 100; latency++) record(telemetry, latency, null);
		const latency = telemetry.snapshot().latency;
		expect(latency.count).toBe(100);
		expect(latency.p50).toBe(50);
		expect(latency.p95).toBe(95);
		expect(latency.mean).toBe(50.5);
	});

	it('keeps at most LATENCY_WINDOW most recent samples', () => {
		const telemetry = new Telemetry();
		for (let latency = 1; latency <= LATENCY_WINDOW + 50; latency++) record(telemetry, latency, null);
		const latency = telemetry.snapshot().latency;
		expect(latency.count).toBe(LATENCY_WINDOW);
		// Window now holds 51..250.
		expect(latency.p50).toBe(150);
		expect(latency.p95).toBe(240);
		expect(latency.mean).toBe(150.5);
	});

	it('ignores non-finite and negative latencies', () => {
		const telemetry = new Telemetry();
		record(telemetry, Number.NaN, null);
		record(telemetry, -5, null);
		record(telemetry, 42, null);
		expect(telemetry.snapshot().latency).toEqual({ count: 1, p50: 42, p95: 42, mean: 42 });
	});
});

describe('Telemetry pricing', () => {
	it('reports no cost until pricing is configured', () => {
		const telemetry = new Telemetry();
		record(telemetry, 100, usage(1000, 500));
		expect(telemetry.snapshot().estimatedCostUsd).toBeNull();
		telemetry.setPricing({ inputPerMillion: 1, outputPerMillion: 2 });
		expect(telemetry.snapshot().estimatedCostUsd).toBe(0.002);
	});

	it('can disable cost estimation again', () => {
		const telemetry = new Telemetry();
		telemetry.setPricing({ inputPerMillion: 10, outputPerMillion: 10 });
		record(telemetry, 100, usage(1_000_000, 0));
		expect(telemetry.snapshot().estimatedCostUsd).toBe(10);
		telemetry.setPricing(null);
		expect(telemetry.snapshot().estimatedCostUsd).toBeNull();
	});
});

describe('Telemetry reset', () => {
	it('clears counters and re-anchors startedAt but keeps pricing', () => {
		let now = 5000;
		const telemetry = new Telemetry({ now: () => now, startedAt: 1000 });
		telemetry.setPricing({ inputPerMillion: 1, outputPerMillion: 1 });
		record(telemetry, 100, usage(1000, 500));
		telemetry.recordCandidateShown('cache');
		telemetry.recordAccept(true);
		telemetry.recordFailure({ latencyMs: 1 });
		now = 9000;
		telemetry.reset();
		const snapshot = telemetry.snapshot();
		expect(snapshot.startedAt).toBe(9000);
		expect(snapshot.requests).toBe(0);
		expect(snapshot.candidatesShown).toBe(0);
		expect(snapshot.fullAccepts).toBe(0);
		expect(snapshot.requestFailures).toBe(0);
		expect(snapshot.latency).toEqual({ count: 0, p50: 0, p95: 0, mean: 0 });
		expect(snapshot.estimatedCostUsd).toBe(0); // pricing kept, zero tokens
	});
});

describe('Telemetry candidate linkage', () => {
	it('retains the last request timestamp for diagnostics', () => {
		const telemetry = new Telemetry();
		telemetry.recordRequest({
			startedAt: 777,
			latencyMs: 50,
			usage: usage(10, 5),
			candidate: candidate(3),
		});
		expect(telemetry.lastRequestAt).toBe(777);
	});
});
