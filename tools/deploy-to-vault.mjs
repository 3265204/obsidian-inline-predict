#!/usr/bin/env node
/**
 * Copy the built plugin into an Obsidian vault for manual testing.
 *
 *   npm run deploy                          # default target: docetest/test
 *   VAULT=/path/to/vault npm run deploy
 *
 * The build itself is done by `npm run build` before this script runs. After copying, reload
 * Obsidian (Cmd+R / Ctrl+R) or toggle the plugin off/on to pick up the new bundle.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PLUGIN_ID = 'inline-predict';
const vault = process.env.VAULT ?? resolve(ROOT, 'docetest', 'test');
const target = resolve(vault, '.obsidian', 'plugins', PLUGIN_ID);

if (!existsSync(resolve(vault, '.obsidian'))) {
	console.error(`Not an Obsidian vault (no .obsidian directory): ${vault}`);
	process.exit(1);
}
mkdirSync(target, { recursive: true });

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	const source = resolve(ROOT, file);
	if (!existsSync(source)) {
		console.error(`Missing build artifact: ${source}. Run \`npm run build\` first.`);
		process.exit(1);
	}
	copyFileSync(source, resolve(target, file));
}

console.log(`deployed ${PLUGIN_ID} -> ${target}`);
console.log('reload Obsidian (Cmd+R) to load the new bundle');
