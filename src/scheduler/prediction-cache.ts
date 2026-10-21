/**
 * L1 prediction cache.
 *
 * Stores finished candidates so a later snapshot that still matches their prefix can show ghost
 * text without a model round-trip. Two policies matter:
 *
 * - TTL: a candidate generated against an old state is not trustworthy forever.
 * - LRU: bounded memory (`cacheEntries` setting), evicting the least recently read entry.
 *
 * "Reusable" means the entry has not been consumed. `consume()` is called when a cached candidate
 * is displayed, accepted or rejected; after that it must never be served again. Entries created by
 * a model response stay reusable until one of those events because they may legitimately be
 * re-displayed if the cursor leaves and returns to the same anchor.
 */

import type { CompletionCandidate } from '../core/types';
import { PREDICTION_CACHE_MAX_ENTRIES, PREDICTION_CACHE_TTL_MS } from '../core/constants';

export interface PredictionCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
}

export interface PredictionCacheStats {
	/** Live (non-expired) entries. */
	size: number;
	maxEntries: number;
	ttlMs: number;
	hits: number;
	misses: number;
	evictions: number;
	expired: number;
}

interface CacheEntry {
	candidate: CompletionCandidate;
	storedAt: number;
}

/**
 * Stable key for a candidate. Deliberately excludes `docVersion`: a candidate stays reusable while
 * the user types matching characters (the version changes on every keystroke, the text does not).
 */
export function candidateCacheKey(candidate: CompletionCandidate): string {
	return `${candidate.docId}\u0000${candidate.anchor}\u0000${candidate.text}`;
}

export class LruPredictionCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly now: () => number;
	private ttlMs: number;
	private maxEntries: number;
	private hits = 0;
	private misses = 0;
	private evictions = 0;
	private expired = 0;

	constructor(options: PredictionCacheOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.ttlMs = Math.max(0, options.ttlMs ?? PREDICTION_CACHE_TTL_MS);
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? PREDICTION_CACHE_MAX_ENTRIES));
	}

	/** Live entry count (expired entries are purged first). */
	get size(): number {
		this.purgeExpired();
		return this.entries.size;
	}

	setMaxEntries(maxEntries: number): void {
		this.maxEntries = Math.max(1, Math.floor(maxEntries));
		this.evictOverflow();
	}

	setTtlMs(ttlMs: number): void {
		this.ttlMs = Math.max(0, ttlMs);
		this.purgeExpired();
	}

	/**
	 * Read one entry (LRU touch). Returns null for missing/expired/consumed entries.
	 * `hits`/`misses` count reads so the cache can report its own effectiveness.
	 */
	get(key: string): CompletionCandidate | null {
		this.purgeExpired();
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses++;
			return null;
		}
		// Re-insert to move the entry to the MRU end of the Map's insertion order.
		this.entries.delete(key);
		this.entries.set(key, entry);
		this.hits++;
		return entry.candidate;
	}

	set(key: string, candidate: CompletionCandidate): void {
		if (candidate.text.length === 0) return;
		this.purgeExpired();
		this.entries.delete(key);
		this.entries.set(key, { candidate, storedAt: this.now() });
		this.evictOverflow();
	}

	/** Read and remove. Used when a candidate is shown from cache, accepted or rejected. */
	consume(key: string): CompletionCandidate | null {
		this.purgeExpired();
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses++;
			return null;
		}
		this.entries.delete(key);
		this.hits++;
		return entry.candidate;
	}

	clear(): void {
		this.entries.clear();
		this.hits = 0;
		this.misses = 0;
		this.evictions = 0;
		this.expired = 0;
	}

	/**
	 * Reusable candidates, most recently stored first. Callers pass these to
	 * `findReusableCached`; iteration order defines match priority (newest wins).
	 */
	entriesInRecencyOrder(): readonly CompletionCandidate[] {
		this.purgeExpired();
		return Array.from(this.entries.values(), (entry) => entry.candidate).reverse();
	}

	stats(): PredictionCacheStats {
		return {
			size: this.size,
			maxEntries: this.maxEntries,
			ttlMs: this.ttlMs,
			hits: this.hits,
			misses: this.misses,
			evictions: this.evictions,
			expired: this.expired,
		};
	}

	private purgeExpired(): void {
		if (this.ttlMs <= 0) return;
		const cutoff = this.now() - this.ttlMs;
		for (const [key, entry] of this.entries) {
			if (entry.storedAt <= cutoff) {
				this.entries.delete(key);
				this.expired++;
			}
		}
	}

	private evictOverflow(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) return;
			this.entries.delete(oldest.value);
			this.evictions++;
		}
	}
}
