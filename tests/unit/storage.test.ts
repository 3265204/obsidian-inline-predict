import { describe, expect, it } from 'vitest';
import {
	PREDICTIVE_ROOT,
	PROFILE_DIR,
	INDEX_DIR,
	CACHE_DIR,
	isInsidePredictive,
	normalizeVaultPath,
	predictivePath,
} from '../../src/storage/paths';
import { VaultStorage } from '../../src/storage/vault-storage';
import type { VaultAdapterLike } from '../../src/storage/types';

interface MemoryAdapter {
	adapter: VaultAdapterLike;
	files: Map<string, string>;
	folders: Set<string>;
}

/**
 * In-memory stand-in for Obsidian's vault adapter. Mirrors the parts that matter:
 * - `mkdir` rejects when the folder exists (forces ensureDir to be idempotent),
 * - `list` returns vault-relative paths of immediate children,
 * - `rename` is optional so the fallback path is testable.
 */
function createMemoryAdapter(options: { rename?: boolean } = {}): MemoryAdapter {
	const files = new Map<string, string>();
	const folders = new Set<string>();

	const adapter: VaultAdapterLike = {
		async exists(path: string): Promise<boolean> {
			return files.has(path) || folders.has(path);
		},
		async read(path: string): Promise<string> {
			const value = files.get(path);
			if (value === undefined) throw new Error(`ENOENT: ${path}`);
			return value;
		},
		async write(path: string, data: string): Promise<void> {
			files.set(path, data);
		},
		async mkdir(path: string): Promise<void> {
			if (folders.has(path)) throw new Error(`EEXIST: ${path}`);
			folders.add(path);
		},
		async remove(path: string): Promise<void> {
			files.delete(path);
			folders.delete(path);
		},
		async list(path: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = `${path}/`;
			const immediate = (candidate: string): boolean =>
				candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/');
			return {
				files: [...files.keys()].filter(immediate).sort(),
				folders: [...folders].filter(immediate).sort(),
			};
		},
	};

	if (options.rename !== false) {
		adapter.rename = async (from: string, to: string): Promise<void> => {
			const value = files.get(from);
			if (value === undefined) throw new Error(`ENOENT: ${from}`);
			files.delete(from);
			files.set(to, value);
		};
	}

	return { adapter, files, folders };
}

interface StyleProfile {
	schemaVersion: number;
	tone: string;
}

function guardProfile(value: unknown): StyleProfile | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.tone !== 'string') return null;
	return { schemaVersion: 1, tone: record.tone };
}

function corruptFiles(files: Map<string, string>): string[] {
	return [...files.keys()].filter((path) => /\.corrupt-\d+$/.test(path));
}

describe('paths', () => {
	it('exposes the hidden data root and its subdirectories', () => {
		expect(PREDICTIVE_ROOT).toBe('.predictive');
		expect(PROFILE_DIR).toBe('.predictive/profile');
		expect(INDEX_DIR).toBe('.predictive/index');
		expect(CACHE_DIR).toBe('.predictive/cache');
	});

	it('normalizes separators, duplicate slashes and dot segments', () => {
		expect(normalizeVaultPath('a\\b//c/./d/')).toBe('a/b/c/d');
		expect(normalizeVaultPath('/leading/trailing/')).toBe('leading/trailing');
		expect(normalizeVaultPath('')).toBe('');
	});

	it('builds predictive paths with forward slashes', () => {
		expect(predictivePath()).toBe('.predictive');
		expect(predictivePath('profile', 'style.json')).toBe('.predictive/profile/style.json');
		expect(predictivePath('.predictive', 'cache', 'x.json')).toBe('.predictive/cache/x.json');
	});

	it('refuses traversal above the vault root', () => {
		expect(() => normalizeVaultPath('../outside.md')).toThrow(RangeError);
	});

	it('detects paths inside .predictive only', () => {
		expect(isInsidePredictive('.predictive')).toBe(true);
		expect(isInsidePredictive('.predictive/profile/x.json')).toBe(true);
		expect(isInsidePredictive('notes/.predictive/x.json')).toBe(false);
		expect(isInsidePredictive('.predictive-old/x.json')).toBe(false);
		expect(isInsidePredictive('../.predictive/x.json')).toBe(false);
	});
});

describe('VaultStorage.ensureDir', () => {
	it('creates the root when no path is given', async () => {
		const { adapter, folders } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.ensureDir();

		expect([...folders]).toEqual(['.predictive']);
	});

	it('creates nested folders segment by segment and is idempotent', async () => {
		const { adapter, folders } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.ensureDir('profile/deep');
		await storage.ensureDir('profile/deep');

		expect(folders).toEqual(
			new Set(['.predictive', '.predictive/profile', '.predictive/profile/deep']),
		);
	});
});

describe('VaultStorage JSON round trip', () => {
	it('writes pretty JSON under .predictive and reads it back', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.writeJson('profile/style.json', { schemaVersion: 1, tone: 'direct' });

		const stored = files.get('.predictive/profile/style.json');
		expect(stored).toBeDefined();
		expect(stored?.endsWith('\n')).toBe(true);
		expect(JSON.parse(stored ?? '')).toEqual({ schemaVersion: 1, tone: 'direct' });

		const read = await storage.readJson('profile/style.json', guardProfile);
		expect(read).toEqual({ schemaVersion: 1, tone: 'direct' });
		expect(await storage.exists('profile/style.json')).toBe(true);
	});

	it('writes atomically (tmp then rename) and leaves no temp file', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.writeJson('cache/x.json', { a: 1 });

		expect([...files.keys()]).toEqual(['.predictive/cache/x.json']);
		expect([...files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
	});

	it('falls back to a direct write when rename is not supported', async () => {
		const { adapter, files } = createMemoryAdapter({ rename: false });
		const storage = new VaultStorage(adapter);

		await storage.writeJson('cache/x.json', { a: 1 });

		expect(files.get('.predictive/cache/x.json')).toBe('{\n  "a": 1\n}\n');
		expect([...files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
	});

	it('normalizes caller paths into the predictive tree', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.writeJson('/profile//style.json', { a: 1 });
		await storage.writeJson('.predictive/profile/style.json', { a: 2 });
		await storage.writeJson('.predictive/../root.json', { a: 3 });

		expect([...files.keys()].sort()).toEqual([
			'.predictive/profile/style.json',
			'.predictive/root.json',
		]);
		expect(await storage.exists('profile/style.json')).toBe(true);
	});

	it('rejects paths that would escape the vault', async () => {
		const { adapter } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await expect(storage.writeJson('../outside.json', { a: 1 })).rejects.toBeInstanceOf(
			RangeError,
		);
	});

	it('rejects values JSON cannot represent', async () => {
		const { adapter } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await expect(storage.writeJson('x.json', undefined)).rejects.toBeInstanceOf(TypeError);
	});

	it('lists immediate files of a folder as full vault paths', async () => {
		const { adapter } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.writeJson('profile/b.json', { n: 2 });
		await storage.writeJson('profile/a.json', { n: 1 });
		await storage.writeJson('cache/x.json', { n: 3 });

		expect(await storage.list('profile')).toEqual([
			'.predictive/profile/a.json',
			'.predictive/profile/b.json',
		]);
		expect(await storage.list('.predictive/profile')).toEqual([
			'.predictive/profile/a.json',
			'.predictive/profile/b.json',
		]);
		expect(await storage.list('missing')).toEqual([]);
	});

	it('removes files and treats a missing file as already removed', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		await storage.writeJson('cache/x.json', { a: 1 });
		await storage.remove('cache/x.json');
		await storage.remove('cache/x.json');

		expect(files.has('.predictive/cache/x.json')).toBe(false);
	});
});

describe('VaultStorage corruption recovery', () => {
	it('returns null for a missing file without quarantining anything', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);

		expect(await storage.readJson('profile/missing.json', guardProfile)).toBeNull();
		expect(corruptFiles(files)).toEqual([]);
	});

	it('quarantines invalid JSON and returns null', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);
		files.set('.predictive/profile/style.json', '{ not valid json');

		expect(await storage.readJson('profile/style.json', guardProfile)).toBeNull();

		expect(files.has('.predictive/profile/style.json')).toBe(false);
		const quarantined = corruptFiles(files);
		expect(quarantined).toHaveLength(1);
		expect(files.get(quarantined[0] ?? '')).toBe('{ not valid json');
	});

	it('quarantines JSON rejected by the guard', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);
		files.set('.predictive/profile/style.json', JSON.stringify({ schemaVersion: 99 }));

		expect(await storage.readJson('profile/style.json', guardProfile)).toBeNull();
		expect(corruptFiles(files)).toHaveLength(1);
	});

	it('quarantines when a guard throws instead of returning null', async () => {
		const { adapter, files } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);
		files.set('.predictive/profile/style.json', '{"schemaVersion":1,"tone":"x"}');

		const throwingGuard = (): StyleProfile | null => {
			throw new Error('guard exploded');
		};

		expect(await storage.readJson('profile/style.json', throwingGuard)).toBeNull();
		expect(corruptFiles(files)).toHaveLength(1);
	});

	it('keeps reading safe when rename is unsupported', async () => {
		const { adapter, files } = createMemoryAdapter({ rename: false });
		const storage = new VaultStorage(adapter);
		files.set('.predictive/profile/style.json', 'not json');

		expect(await storage.readJson('profile/style.json', guardProfile)).toBeNull();
		expect(files.get('.predictive/profile/style.json')).toBe('not json');
	});

	it('returns null instead of throwing when the adapter read fails', async () => {
		const { adapter } = createMemoryAdapter();
		const storage = new VaultStorage(adapter);
		await storage.writeJson('profile/style.json', { schemaVersion: 1, tone: 'x' });
		adapter.read = async (): Promise<string> => {
			throw new Error('IO error');
		};

		expect(await storage.readJson('profile/style.json', guardProfile)).toBeNull();
	});
});
