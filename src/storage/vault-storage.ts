/**
 * JSON storage over `VaultAdapterLike` (Obsidian's vault adapter).
 *
 * Design rules:
 * - Path arguments are vault-relative; paths outside `.predictive/` are rewritten to live
 *   under it (so this class can never write into the notes tree by accident).
 * - `readJson` never throws. Missing, unreadable, invalid or rejected data yields `null`; when
 *   the adapter supports renaming, the bad file is quarantined as `<path>.corrupt-<ts>` so the
 *   user can inspect it and the plugin can write a fresh file next time.
 * - `writeJson` is atomic when `rename` is available: write `.tmp`, then rename into place.
 *   Adapters without rename (some mobile/sync-backed adapters) get a direct write.
 */

import { PREDICTIVE_ROOT, normalizeVaultPath } from './paths';
import type { JsonGuard, VaultAdapterLike } from './types';

/** Parent directory of a normalized path, or `''` for a top-level file. */
function parentPath(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

export class VaultStorage {
	/** Hidden data root inside the vault. */
	readonly root: string = PREDICTIVE_ROOT;

	private readonly adapter: VaultAdapterLike;

	constructor(adapter: VaultAdapterLike) {
		this.adapter = adapter;
	}

	/**
	 * Create a folder (default: the `.predictive` root) and every missing ancestor.
	 * Idempotent: an existing folder is not an error, even if `mkdir` rejects.
	 */
	async ensureDir(relative = ''): Promise<void> {
		const target = this.resolve(relative);
		let current = '';
		for (const segment of target.split('/')) {
			if (segment.length === 0) continue;
			current = current.length === 0 ? segment : `${current}/${segment}`;
			if (await this.adapter.exists(current)) continue;
			try {
				await this.adapter.mkdir(current);
			} catch (error) {
				// Another writer may have created it between our check and mkdir.
				if (!(await this.adapter.exists(current))) throw error;
			}
		}
	}

	async exists(relative: string): Promise<boolean> {
		return this.adapter.exists(this.resolve(relative));
	}

	/**
	 * Read and validate JSON. Never throws: any failure is reported as `null`, and parse/guard
	 * failures quarantine the file when the adapter supports rename.
	 */
	async readJson<T>(relative: string, guard: JsonGuard<T>): Promise<T | null> {
		let path: string;
		try {
			path = this.resolve(relative);
		} catch {
			return null;
		}

		let raw: string;
		try {
			if (!(await this.adapter.exists(path))) return null;
			raw = await this.adapter.read(path);
		} catch {
			// Missing (race) or unreadable file: same outcome as absent.
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			await this.quarantine(path);
			return null;
		}

		let value: T | null = null;
		try {
			value = guard(parsed);
		} catch {
			value = null;
		}
		if (value === null) {
			await this.quarantine(path);
			return null;
		}
		return value;
	}

	/**
	 * Persist pretty-printed JSON, creating parent folders. Rejects only for values JSON cannot
	 * represent (e.g. `undefined`, functions) or when the adapter write itself fails.
	 */
	async writeJson(relative: string, value: unknown): Promise<void> {
		const path = this.resolve(relative);
		const serialized = JSON.stringify(value, null, 2);
		if (serialized === undefined) {
			throw new TypeError(`Cannot serialize a JSON value for ${path}`);
		}
		const data = `${serialized}\n`;
		await this.ensureDir(parentPath(path));

		if (typeof this.adapter.rename === 'function') {
			const temporary = `${path}.tmp`;
			try {
				await this.adapter.write(temporary, data);
				await this.adapter.rename(temporary, path);
				return;
			} catch {
				// rename is optional in practice: some adapters reject it. Clean up and write directly.
				try {
					await this.adapter.remove(temporary);
				} catch {
					// Ignore: a leftover .tmp is harmless and overwritten on the next write.
				}
			}
		}

		await this.adapter.write(path, data);
	}

	/** Best-effort delete; a missing file is not an error. */
	async remove(relative: string): Promise<void> {
		try {
			await this.adapter.remove(this.resolve(relative));
		} catch {
			// Already gone or adapter refused; callers treat deletion as idempotent.
		}
	}

	/** Immediate file children of a folder, as vault-relative paths. Errors yield `[]`. */
	async list(relative: string): Promise<string[]> {
		try {
			const listed = await this.adapter.list(this.resolve(relative));
			return [...listed.files].sort();
		} catch {
			return [];
		}
	}

	/**
	 * Map a caller path into the `.predictive/` tree:
	 * - `''` → the root itself,
	 * - already inside `.predictive/` → unchanged,
	 * - anything else → prefixed with the root (e.g. `profile/x.json` → `.predictive/profile/x.json`).
	 */
	private resolve(relative: string): string {
		const normalized = normalizeVaultPath(relative);
		if (normalized.length === 0) return this.root;
		if (normalized === this.root || normalized.startsWith(`${this.root}/`)) {
			return normalized;
		}
		return normalizeVaultPath(`${this.root}/${normalized}`);
	}

	/** Rename a bad file out of the way (best effort; readJson keeps its never-throw promise). */
	private async quarantine(path: string): Promise<void> {
		if (typeof this.adapter.rename !== 'function') return;
		try {
			await this.adapter.rename(path, `${path}.corrupt-${Date.now()}`);
		} catch {
			// Quarantine is a convenience, not a guarantee.
		}
	}
}
