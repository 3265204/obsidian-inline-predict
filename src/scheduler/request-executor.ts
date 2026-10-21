/** 执行单个编辑会话的预测请求。先记录已发生的调用，再校验版本、光标和文件路径，避免过期结果污染编辑器。 */

import { ModelError } from '../core/types';
import type {
	BuiltContext,
	CompletionCandidate,
	ContextBuilder,
	ModelCallRecord,
	EditorSnapshot,
	PredictionOutcome,
	PredictionRunner,
	PredictionSkipReason,
	TokenUsage,
} from '../core/types';
import type { SchedulerConfig } from './scheduler';

let nextRequestId = 0;

/** 已完成请求的结果；即使过期，也需要先记录其中的用量。 */
export interface RequestResult {
	startedAt: number;
	latencyMs: number;
	candidate: CompletionCandidate | null;
	usage: TokenUsage | null;
	/** Why no candidate was produced (null when a candidate exists). */
	reason: PredictionSkipReason | null;
	modelCalls?: readonly ModelCallRecord[];
}

/** Callbacks into the scheduler. All are invoked synchronously from the async request task. */
export interface RequestObserver {
	/** 先记录已经发生的调用，再决定是否丢弃过期或配置已变化的候选。 */
	onSettled(result: RequestResult): void;
	/** A request actually started (the previous one, if any, has been aborted). */
	onStarted(): void;
	/** Completed and still matches the current snapshot. */
	onResult(result: RequestResult): void;
	/** Failed for a real reason; aborts are never reported here. */
	onFailure(latencyMs: number): void;
	/** A completed result was dropped because the document/cursor moved on. */
	onStale(): void;
}

export interface RequestExecutorDeps {
	contextBuilder: ContextBuilder;
	runner: PredictionRunner;
	getConfig(): SchedulerConfig;
	/** Latest editor snapshot, used to re-validate a result before applying it. */
	getSnapshot(): EditorSnapshot | null;
	now(): number;
}

interface InFlightRequest {
	requestId: number;
	controller: AbortController;
	snapshot: EditorSnapshot;
}

function isAbortedError(error: unknown): boolean {
	if (error instanceof ModelError) return error.kind === 'aborted';
	if (error instanceof Error) return error.name === 'AbortError';
	return false;
}

function isCurrentSnapshot(
	current: EditorSnapshot | null,
	requested: EditorSnapshot,
): current is EditorSnapshot {
	if (current === null) return false;
	return (
		current.docId === requested.docId &&
		current.docVersion === requested.docVersion &&
		current.cursor === requested.cursor &&
		!current.isComposing
	);
}

export class RequestExecutor {
	private readonly deps: RequestExecutorDeps;
	private requestSeq = 0;
	private inFlight: InFlightRequest | null = null;
	private lastRequestStartedAt: number | null = null;
	private staleDrops = 0;
	private disposed = false;

	constructor(deps: RequestExecutorDeps) {
		this.deps = deps;
	}

	/** Timestamp of the last request start (drives the minimum-interval rule). */
	get lastRequestAt(): number | null {
		return this.lastRequestStartedAt;
	}

	/** Number of results dropped because the document/cursor moved on. */
	get staleDropped(): number {
		return this.staleDrops;
	}

	get isInFlight(): boolean {
		return this.inFlight !== null;
	}

	/** Start a request for the current snapshot. Supersedes (aborts) the previous one. */
	start(observer: RequestObserver): void {
		if (this.disposed) return;
		const snapshot = this.deps.getSnapshot();
		if (snapshot === null || snapshot.isComposing) return;
		const requestId = ++nextRequestId;
		this.requestSeq = requestId;
		if (this.inFlight !== null) this.inFlight.controller.abort();
		const controller = new AbortController();
		this.inFlight = { requestId, controller, snapshot };
		this.lastRequestStartedAt = this.deps.now();
		observer.onStarted();
		void this.execute(requestId, snapshot, controller, observer);
	}

	abort(): void {
		if (this.inFlight === null) return;
		this.inFlight.controller.abort();
		this.inFlight = null;
	}

	dispose(): void {
		this.disposed = true;
		this.abort();
	}

	private async execute(
		requestId: number,
		snapshot: EditorSnapshot,
		controller: AbortController,
		observer: RequestObserver,
	): Promise<void> {
		const config = this.deps.getConfig();
		const startedAt = this.deps.now();
		let runnerStarted = false;
		let accounted = false;
		try {
			const context: BuiltContext = await this.deps.contextBuilder.build(
				snapshot,
				controller.signal,
			);
			if (this.isStale(requestId, controller)) return;
			runnerStarted = true;
			const outcome: PredictionOutcome = await this.deps.runner.predict(context, {
				requestId,
				signal: controller.signal,
				timeoutMs: config.requestTimeoutMs,
				maxOutputTokens: config.maxOutputTokens,
				temperature: config.temperature,
			});
			const latencyMs = this.deps.now() - startedAt;
			const result: RequestResult = { startedAt, latencyMs, ...outcome };
			accounted = true;
			observer.onSettled(result);
			if (this.isStale(requestId, controller)) return;
			const current = this.deps.getSnapshot();
			if (!isCurrentSnapshot(current, snapshot)) {
				this.staleDrops++;
				observer.onStale();
				return;
			}
			const candidate = outcome.candidate;
			if (outcome.reason === 'error' || outcome.reason === 'timeout' || outcome.reason === 'rate-limited') {
				observer.onFailure(latencyMs);
				return;
			}
			if (
				candidate !== null &&
				(candidate.docId !== snapshot.docId ||
					current.cursor !== candidate.anchor)
			) {
				this.staleDrops++;
				observer.onStale();
				return;
			}
			observer.onResult({ ...result, candidate: candidate === null ? null : {
				...candidate,
				requestId,
				reuseContext: { prefix: snapshot.prefix, prefixOffset: snapshot.prefixOffset, suffix: snapshot.suffix },
			} });
		} catch (error: unknown) {
			if (!accounted) observer.onSettled({
				startedAt, latencyMs: this.deps.now() - startedAt, candidate: null, usage: null,
				reason: controller.signal.aborted || isAbortedError(error) ? 'aborted' : 'error',
				modelCalls: runnerStarted ? [{ usage: null, failed: !controller.signal.aborted && !isAbortedError(error) }] : [],
			});
			if (this.disposed) return;
			// Superseded/disposed requests are normal control flow, never failures.
			if (controller.signal.aborted || isAbortedError(error)) return;
			if (requestId !== this.requestSeq) return;
			observer.onFailure(this.deps.now() - startedAt);
		} finally {
			if (this.inFlight !== null && this.inFlight.requestId === requestId) {
				this.inFlight = null;
			}
		}
	}

	private isStale(requestId: number, controller: AbortController): boolean {
		return this.disposed || controller.signal.aborted || requestId !== this.requestSeq;
	}
}

