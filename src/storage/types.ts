/**
 * Storage adapter contract.
 *
 * Obsidian exposes local storage through `Vault.adapter`, which differs between desktop
 * (fs-backed) and mobile (Capacitor/WebView). This interface is the *only* storage surface the
 * plugin code is allowed to know about: no Node `fs`, no `path`, no Electron APIs. It is
 * structurally compatible with `DataAdapter` from `obsidian`, but does not import it so unit
 * tests can use a plain in-memory object.
 */

export interface VaultAdapterLike {
	/** True when a file or folder exists at the vault-relative path. */
	exists(path: string): Promise<boolean>;
	/** Read a file as UTF-8. Rejects when the file is missing. */
	read(path: string): Promise<string>;
	/** Write a file as UTF-8. Parent folders are created by the caller (VaultStorage). */
	write(path: string, data: string): Promise<void>;
	/** Create one folder. Rejects when it already exists on some adapters. */
	mkdir(path: string): Promise<void>;
	/** Remove a file or an empty folder. */
	remove(path: string): Promise<void>;
	/** List the immediate children of a folder. Paths are vault-relative. */
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	/**
	 * Optional rename. Used for atomic JSON writes and corruption quarantine; when an adapter
	 * does not implement it, VaultStorage degrades to direct writes (documented behaviour).
	 */
	rename?(from: string, to: string): Promise<void>;
	/** Optional metadata. Not required for correctness; future index freshness checks use it. */
	stat?(path: string): Promise<{ mtime: number; size: number } | null>;
}

/**
 * Parse/sanitize untrusted JSON into `T`, or return `null` to reject it.
 *
 * Returning `null` from a guard makes `VaultStorage.readJson` treat the file as corrupt,
 * quarantine it and report missing data. Guards must not throw; if one does, the same
 * quarantine path is taken.
 */
export type JsonGuard<T> = (value: unknown) => T | null;
