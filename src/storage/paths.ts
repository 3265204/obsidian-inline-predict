/**
 * Path helpers for the plugin's hidden vault data directory.
 *
 * Deliberately string-based: importing Node's `path` would break mobile builds. Every path is
 * vault-relative, uses forward slashes, has no leading/trailing slash and contains no `.`/`..`
 * segments after normalization.
 */

/** Root of all plugin data, inside the vault. */
export const PREDICTIVE_ROOT = '.predictive';

/** Writing profile (M6). */
export const PROFILE_DIR = `${PREDICTIVE_ROOT}/profile`;

/** Retrieval index (M4+). Excluded from retrieval itself so we never index our own data. */
export const INDEX_DIR = `${PREDICTIVE_ROOT}/index`;

/** Disposable caches (warming data that can be rebuilt). */
export const CACHE_DIR = `${PREDICTIVE_ROOT}/cache`;

/**
 * Remove redundant separators and resolve `.`/`..` without touching the filesystem.
 * Throws `RangeError` when a path escapes the vault root (`..` beyond the first segment), which
 * keeps callers from accidentally writing outside the vault with a computed path.
 */
export function normalizeVaultPath(path: string): string {
	const segments: string[] = [];
	for (const part of path.replace(/\\/g, '/').split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (segments.length === 0) {
				throw new RangeError(`Path escapes the vault root: ${path}`);
			}
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return segments.join('/');
}

/**
 * Build a normalized vault-relative path inside `.predictive/`.
 *
 * Passing parts that already include the root (or a full path) does not double-prefix; this
 * keeps callers that mix `PROFILE_DIR` constants and plain relative names safe.
 */
export function predictivePath(...parts: string[]): string {
	const joined = normalizeVaultPath(parts.join('/'));
	if (joined.length === 0) return PREDICTIVE_ROOT;
	if (joined === PREDICTIVE_ROOT || joined.startsWith(`${PREDICTIVE_ROOT}/`)) return joined;
	return `${PREDICTIVE_ROOT}/${joined}`;
}

/**
 * True when the path refers to the `.predictive` root or something below it.
 * Traversal attempts and invalid paths are reported as `false`, never thrown.
 */
export function isInsidePredictive(path: string): boolean {
	let normalized: string;
	try {
		normalized = normalizeVaultPath(path);
	} catch {
		return false;
	}
	return normalized === PREDICTIVE_ROOT || normalized.startsWith(`${PREDICTIVE_ROOT}/`);
}
