/**
 * Inline Predict 的跨模块契约。
 *
 * Rule of thumb: this file may only depend on TypeScript built-ins. Every other module may
 * depend on this file. If a contract changes, every producer/consumer changes in the same
 * commit — see AGENTS.md invariant #8.
 */

/* ------------------------------------------------------------------ */
/* Tokens & model                                                      */
/* ------------------------------------------------------------------ */

/** 返回取消函数，避免把浏览器或 Node 的计时器句柄泄漏到纯逻辑层。 */
export interface TimerScheduler {
	schedule(callback: () => void, delayMs: number): () => void;
}

/**
 * Token accounting. `estimated` separates heuristic counts from values returned by the
 * provider, which are authoritative. `cachedInputTokens` is only set when the provider
 * reports prompt-cache reads.
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
	estimated: boolean;
}

/** Normalized provider stop reasons. `length` means the output was truncated. */
export type FinishReason =
	| 'stop'
	| 'length'
	| 'content_filter'
	| 'tool_calls'
	| 'error'
	| 'unknown';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface TokenCounter {
	/** Stable id so telemetry can tell heuristic and model-specific counters apart. */
	readonly id: string;
	count(text: string): number;
}

/**
 * Counts prompt tokens with the exact chat framing used by the adapter when possible.
 * Adapters may implement this to replace the default heuristic.
 */
export interface ChatTokenCounter extends TokenCounter {
	countMessages(messages: readonly ChatMessage[]): number;
}

/* ------------------------------------------------------------------ */
/* Editor snapshot                                                     */
/* ------------------------------------------------------------------ */

export type SnapshotTrigger =
	| 'doc-change'
	| 'selection'
	| 'file-open'
	| 'manual'
	| 'idle'
	| 'composition-end';

export type EditorMode = 'source' | 'live' | 'reading';

/** A single document mutation, relative to the previous document state. */
export interface EditDelta {
	/** Absolute offset (before the edit) where the change started. */
	from: number;
	/** Absolute offset (before the edit) where the change ended. */
	to: number;
	insertedText: string;
	removedLength: number;
	at: number;
}

/**
 * Immutable view of the editor at one point in time. The observer caps prefix/suffix size so a
 * keystroke never copies the whole document.
 */
export interface EditorSnapshot {
	/** Vault path; empty string for untitled/new buffers. */
	docId: string;
	/** Monotonic per session; bumped on every document change. Guards stale responses. */
	docVersion: number;
	/** Absolute cursor offset in the document. */
	cursor: number;
	/** Selection; equal to `cursor` when there is no selection. */
	selectionFrom: number;
	selectionTo: number;
	/** Text before the cursor, capped. `absoluteOffset = prefixOffset + index`. */
	prefix: string;
	prefixOffset: number;
	/** Text after the cursor, capped. `absoluteOffset = cursor + index`. */
	suffix: string;
	/** 0-based line / column at the cursor. */
	line: number;
	ch: number;
	lineTextBefore: string;
	lineTextAfter: string;
	isComposing: boolean;
	timestamp: number;
	trigger: SnapshotTrigger;
	lastEdit: EditDelta | null;
	language: string | null;
	mode: EditorMode;
	/** True when the cursor is inside a fenced code block or math block. */
	inCodeBlock: boolean;
	inMathBlock: boolean;
}

/* ------------------------------------------------------------------ */
/* Context assembly & token budget                                     */
/* ------------------------------------------------------------------ */

export type ContextSectionId =
	| 'rules'
	| 'structure'
	| 'before'
	| 'after'
	| 'knowledge'
	| 'profile'
	| 'recent-edits';

/**
 * Trust boundaries for prompt assembly. Retrieved notes and the user profile are *data*, never
 * instructions; the prompt builder must delimit them accordingly.
 */
export type ContextTrust = 'system' | 'document' | 'retrieved' | 'profile';

export interface ContextSection {
	id: ContextSectionId;
	/** Human-readable delimiter label, e.g. `document-before-cursor`. */
	label: string;
	trust: ContextTrust;
	text: string;
	estimatedTokens: number;
	/** Truncation note when the section had to be trimmed to fit the budget. */
	truncated?: boolean;
}

export interface TokenBudget {
	/** Total input+output window offered by the adapter. */
	windowTokens: number;
	/** Tokens reserved for the model's answer. */
	reservedOutputTokens: number;
	/** Tokens available for input after output reservation and fixed overhead. */
	inputTokens: number;
	/** Per-section ceilings. Missing sections are not sent. */
	allocations: Readonly<Record<ContextSectionId, number>>;
}

export interface TokenBudgetReport {
	budget: TokenBudget;
	usedBySection: Readonly<Record<ContextSectionId, number>>;
	omitted: readonly ContextSectionId[];
	totalInputTokens: number;
}

/** Result of the context engine before prompting. */
export interface BuiltContext {
	snapshot: EditorSnapshot;
	sections: readonly ContextSection[];
	report: TokenBudgetReport;
	createdAt: number;
	/** Cache key material for the warm context that produced this payload. */
	warmKey: string | null;
}

/* ------------------------------------------------------------------ */
/* Predictions                                                         */
/* ------------------------------------------------------------------ */

export type CandidateSource = 'model' | 'cache' | 'prefix-reuse';

export type PredictionSkipReason =
	| 'disabled'
	| 'no-model'
	| 'empty'
	| 'truncated'
	| 'echo'
	| 'timeout'
	| 'aborted'
	| 'error'
	| 'validator-rejected'
	| 'no-intent'
	| 'off-topic'
	| 'budget-exceeded'
	| 'rate-limited';

/** 生成时捕获的有限上下文；复用前必须校验。 */
export interface CandidateContext {
	prefix: string;
	prefixOffset: number;
	suffix: string;
}

/** 一次实际模型调用；包含可选复核，失败时用量可能未知。 */
export interface ModelCallRecord {
	usage: TokenUsage | null;
	failed: boolean;
}

export interface CompletionCandidate {
	/** Request id that produced the candidate; unique per plugin instance. */
	requestId: number;
	text: string;
	docId: string;
	/** Document version the candidate was generated against. */
	docVersion: number;
	/** Absolute offset where `text` should be inserted. */
	anchor: number;
	finishReason: FinishReason;
	usage: TokenUsage | null;
	modelId: string;
	createdAt: number;
	latencyMs: number;
	source: CandidateSource;
	/** True when truncation was repaired (e.g. trailing partial sentence removed). */
	degraded: boolean;
	/** 缺少元数据时禁止复用，不能假定上下文仍然兼容。 */
	reuseContext?: CandidateContext;
}

export interface PredictionOutcome {
	candidate: CompletionCandidate | null;
	reason: PredictionSkipReason | null;
	usage: TokenUsage | null;
	finishReason: FinishReason | null;
	modelCalls?: readonly ModelCallRecord[];
}

/** Absolute range of a document edit. */
export interface TextRange {
	from: number;
	to: number;
}

/**
 * Active ghost-text state kept by the completion controller and rendered by the editor
 * extension. Offsets are absolute document positions.
 */
export interface ActiveSuggestion {
	candidate: CompletionCandidate;
	/** Portion of `candidate.text` still to be shown/accepted (shifts on partial accept). */
	remainingText: string;
	/** Absolute offset where `remainingText` starts. */
	anchor: number;
	/** Document version at the time the suggestion was displayed last. */
	docVersion: number;
	/** Set when the suggestion was produced by prefix reuse from another candidate. */
	reusedFromRequestId: number | null;
}

export type SchedulerStatus =
	| 'idle'
	| 'waiting'
	| 'requesting'
	| 'cached'
	| 'backoff'
	| 'disabled';

/* ------------------------------------------------------------------ */
/* Model adapter                                                       */
/* ------------------------------------------------------------------ */

export interface ModelRequest {
	messages: readonly ChatMessage[];
	maxOutputTokens: number;
	temperature: number;
	/** Cooperative cancellation. Adapters must reject with a `ModelAbortedError`. */
	signal: AbortSignal;
	timeoutMs: number;
	/** Optional request id for diagnostics/log correlation. */
	requestId: number;
}

export interface ModelResponse {
	text: string;
	finishReason: FinishReason;
	usage: TokenUsage | null;
	/** Model id echoed back by the provider, when available. */
	modelId: string;
	/** Raw provider payload; never logged unless the user opts in. */
	raw?: unknown;
}

export interface ModelAdapter {
	readonly id: string;
	readonly modelId: string;
	/** Adapter-declared context window in tokens; drives the budget manager. */
	readonly contextWindow: number;
	/** Optional exact/approximate counter; the heuristic is used when absent. */
	readonly tokenCounter?: ChatTokenCounter;
	complete(request: ModelRequest): Promise<ModelResponse>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ModelErrorKind =
	| 'network'
	| 'timeout'
	| 'aborted'
	| 'auth'
	| 'rate-limit'
	| 'server'
	| 'invalid-response'
	| 'configuration';

export class ModelError extends Error {
	readonly kind: ModelErrorKind;
	readonly retryable: boolean;
	readonly status: number | null;

	constructor(
		kind: ModelErrorKind,
		message: string,
		options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ModelError';
		this.kind = kind;
		this.retryable = options.retryable ?? (kind === 'network' || kind === 'timeout');
		this.status = options.status ?? null;
	}
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

export interface LatencySummary {
	count: number;
	p50: number;
	p95: number;
	mean: number;
}

export interface DiagnosticsSnapshot {
	startedAt: number;
	requests: number;
	modelCalls: number;
	modelCallFailures: number;
	unknownUsageCalls: number;
	providerUsageCalls: number;
	acceptedSuggestions: number;
	requestFailures: number;
	candidatesShown: number;
	cacheHits: number;
	prefixReuses: number;
	/** Suggestions rejected by the local relatedness filter. */
	offTopicRejections: number;
	fullAccepts: number;
	partialAccepts: number;
	rejects: number;
	ignored: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	estimatedUsageRequests: number;
	latency: LatencySummary;
	/** Estimated cost in USD if a price per 1M tokens is configured. */
	estimatedCostUsd: number | null;
}

/* ------------------------------------------------------------------ */
/* Module ports (kept here so modules never import each other)         */
/* ------------------------------------------------------------------ */

/** Options passed by the scheduler to the prediction runner. */
export interface PredictOptions {
	requestId: number;
	signal: AbortSignal;
	timeoutMs: number;
	maxOutputTokens: number;
	temperature: number;
}

/** Producer of prompt-ready context. Implemented by the context engine. */
export interface ContextBuilder {
	/** Assemble hot/warm context for this snapshot, honouring the token budget. */
	build(snapshot: EditorSnapshot, signal: AbortSignal): Promise<BuiltContext>;
	/** Drop warm-cache entries for a document (or everything when omitted). */
	invalidate(docId?: string): void;
}

/** Executes one prediction request end-to-end. Implemented by the prediction module. */
export interface PredictionRunner {
	readonly modelId: string;
	readonly contextWindow: number;
	predict(context: BuiltContext, options: PredictOptions): Promise<PredictionOutcome>;
}

/** The editor-facing scheduler surface consumed by the completion controller. */
export interface SchedulerPort {
	/** Called for every relevant editor event. Scheduler may debounce or ignore it. */
	update(snapshot: EditorSnapshot): void;
	/** Cursor/selection moved without a document change. */
	updateCursor(snapshot: EditorSnapshot): void;
	/** The user accepted (all or part) of the active suggestion. */
	notifyAccepted(acceptedText: string, full: boolean): void;
	/** The user rejected the active suggestion. */
	notifyRejected(): void;
	/** Current suggestion to render, or null. */
	current(): ActiveSuggestion | null;
	/** Called by UI commands to force a prediction from the current snapshot. */
	requestNow(): void;
	/** Settings changed at runtime; pick them up without recreating the scheduler. */
	refresh(): void;
	/** Scheduler pushes suggestion/status changes through these callbacks. */
	setEvents(events: SchedulerEvents): void;
	dispose(): void;
}

/** Feedback events for the (optional) learner and the diagnostics counters. */
export type SuggestionFeedback =
	| { type: 'accept-full'; text: string; latencyMs: number; source: CandidateSource }
	| { type: 'accept-partial'; text: string; source: CandidateSource }
	| { type: 'reject'; shownForMs: number }
	| { type: 'ignored'; shownForMs: number };

/** Sink for feedback. Implemented by telemetry + (later) the feedback learner. */
export type FeedbackSink = (event: SuggestionFeedback) => void;

/** Callbacks the scheduler uses to push state to the editor integration. */
export interface SchedulerEvents {
	onSuggestion(suggestion: ActiveSuggestion | null): void;
	onStatus(status: SchedulerStatus): void;
}
