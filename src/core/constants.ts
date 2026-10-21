/** Shared tunables. Anything user-facing belongs in the settings schema instead. */

/** Characters of text captured before the cursor for context/prompt assembly. */
export const PREFIX_CAPTURE_CHARS = 6000;

/** Characters of text captured after the cursor (needed for FIM and duplicate checks). */
export const SUFFIX_CAPTURE_CHARS = 3000;

/** How many previous snapshots the trigger policy keeps for typing-speed estimation. */
export const EDIT_HISTORY_SIZE = 24;

/** Scheduler bounds. */
export const MIN_REQUEST_INTERVAL_MS = 350;
export const MAX_CONCURRENT_REQUESTS = 1;
export const BACKOFF_BASE_MS = 1500;
export const BACKOFF_MAX_MS = 60_000;
export const REQUEST_DEADLINE_GRACE_MS = 500;

/** L1 prediction cache. */
export const PREDICTION_CACHE_TTL_MS = 5 * 60_000;
export const PREDICTION_CACHE_MAX_ENTRIES = 64;

/** L2 warm context cache. */
export const CONTEXT_CACHE_MAX_ENTRIES = 32;
export const CONTEXT_CACHE_TTL_MS = 10 * 60_000;

/** Ghost text. */
export const GHOST_MAX_CHARS = 8000;

/** Statistics. */
export const LATENCY_WINDOW = 200;
export const PROVIDER_PRICE_UNKNOWN = null;
