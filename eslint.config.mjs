import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{ ignores: ['node_modules/**', 'dist/**', '.tmp/**', 'docetest/**', 'tests/**', 'tools/**', '*.mjs', 'main.js', 'vitest.config.ts'] },
	...obsidianmd.configs.recommended,
	{ languageOptions: { parserOptions: { projectService: true } } },
];
