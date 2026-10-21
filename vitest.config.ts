import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	test: {
		setupFiles: ['tests/setup.ts'],
		include: ['tests/**/*.test.ts', 'tests/**/*.bench.ts'],
		exclude: ['node_modules', 'tests/mocks/**'],
	},
	resolve: {
		alias: {
			// Unit tests never load the real Obsidian runtime. Pure modules avoid
			// importing `obsidian` at all; the few modules that do get this stub.
			obsidian: fileURLToPath(
				new URL('./tests/mocks/obsidian.ts', import.meta.url),
			),
		},
	},
});
