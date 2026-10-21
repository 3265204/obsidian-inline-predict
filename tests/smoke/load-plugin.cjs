#!/usr/bin/env node
/**
 * Runtime smoke test for the built bundle.
 *
 * The unit tests exercise source modules; this script verifies that the *built* `main.js`
 * actually loads, that `onload` registers its extension/commands/settings tab, and that the
 * plugin unloads cleanly — with a stubbed Obsidian module (no app, no network).
 *
 * Usage: npm run build && node tests/smoke/load-plugin.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'main.js');
const { StateField } = require(path.join(ROOT, 'node_modules', '@codemirror', 'state'));

function makeElement() {
	const element = {
		text: '',
		attrs: {},
		children: [],
		classes: new Set(),
		addClass: (cls) => element.classes.add(cls),
		removeClass: (cls) => element.classes.delete(cls),
		setText: (text) => {
			element.text = String(text);
		},
		setAttribute: (name, value) => {
			element.attrs[name] = String(value);
		},
		empty: () => {
			element.children.length = 0;
			element.text = '';
		},
		createDiv: () => {
			const child = makeElement();
			element.children.push(child);
			return child;
		},
		createEl: () => {
			const child = makeElement();
			element.children.push(child);
			return child;
		},
	};
	return element;
}

/* ------------------------------------------------------------------ */
/* Obsidian stub                                                       */
/* ------------------------------------------------------------------ */

const saved = { data: null };
const registered = { commands: [], tabs: [], extensions: [], events: [], statusBars: [] };
let requestUrlCalls = 0;

class Plugin {
	constructor(app) {
		this.app = app;
		this.manifest = { id: 'inline-predict', version: '0.1.0' };
	}
	async loadData() {
		return saved.data;
	}
	async saveData(data) {
		saved.data = data;
	}
	addCommand(command) {
		registered.commands.push(command);
		return command;
	}
	addSettingTab(tab) {
		registered.tabs.push(tab);
	}
	registerEditorExtension(extension) {
		registered.extensions.push(extension);
	}
	registerEvent(ref) {
		registered.events.push(ref);
	}
	registerDomEvent() {}
	registerInterval(id) {
		return id;
	}
	addStatusBarItem() {
		const element = makeElement();
		registered.statusBars.push(element);
		return element;
	}
	addRibbonIcon() {
		return makeElement();
	}
}

class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = makeElement();
	}
}

class Setting {
	constructor(container) {
		this.containerEl = container;
	}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	setDisabled() {
		return this;
	}
	setClass() {
		return this;
	}
	addText() {
		return this;
	}
	addTextArea() {
		return this;
	}
	addToggle() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addSlider() {
		return this;
	}
	addButton(cb) {
		if (typeof cb === 'function') cb({ setButtonText() {}, setDisabled() {}, setWarning() {}, onClick() {} });
		return this;
	}
	addExtraButton() {
		return this;
	}
}

class Modal {
	constructor(app) {
		this.app = app;
		this.containerEl = makeElement();
	}
	open() {}
	close() {}
}

class Notice {
	constructor(message) {
		this.message = String(message);
	}
}

const editorInfoField = StateField.define({ create: () => null, update: (value) => value });
const editorLivePreviewField = StateField.define({
	create: () => false,
	update: (value) => value,
});

const explicitMock = {
	__esModule: true,
	Plugin,
	PluginSettingTab,
	Setting,
	Modal,
	Notice,
	MarkdownView: class MarkdownView {},
	ItemView: class ItemView {},
	WorkspaceLeaf: class WorkspaceLeaf {},
	TFile: class TFile {},
	Component: class Component {},
	moment: { locale: () => 'zh-cn' },
	normalizePath: (p) => p,
	debounce: (fn) => fn,
	editorInfoField,
	editorLivePreviewField,
	requestUrl: async () => {
		requestUrlCalls++;
		throw new Error('network is disabled in the smoke test');
	},
};

/** Unknown Obsidian exports become inert, extendable classes. */
const obsidianMock = new Proxy(explicitMock, {
	get(target, property) {
		if (property in target) return target[property];
		if (typeof property !== 'string') return undefined;
		return class InertObsidianExport {};
	},
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'obsidian') return obsidianMock;
	return originalLoad.call(this, request, parent, isMain);
};

// The repo's package.json is `"type": "module"` (required by esbuild config / vitest), but the
// bundle Obsidian loads is CommonJS. Force CJS compilation for main.js only.
const originalJsHandler = Module._extensions['.js'];
Module._extensions['.js'] = function patchedJs(module, filename) {
	if (path.resolve(filename) === MAIN) {
		module._compile(fs.readFileSync(filename, 'utf8'), filename);
		return;
	}
	originalJsHandler(module, filename);
};

/* ------------------------------------------------------------------ */
/* Fake app                                                            */
/* ------------------------------------------------------------------ */

const adapter = {
	exists: async () => false,
	read: async () => {
		throw new Error('not found');
	},
	write: async () => {},
	mkdir: async () => {},
	remove: async () => {},
	rename: async () => {},
	list: async () => ({ files: [], folders: [] }),
	stat: async () => null,
};

const app = {
	vault: {
		adapter,
		on: () => ({}),
		getMarkdownFiles: () => [],
	},
	workspace: {
		on: () => ({}),
		getActiveViewOfType: () => null,
	},
	setting: { open() {}, openTabById() {} },
};

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

(async () => {
	const loaded = require(MAIN);
	const PluginClass = loaded.default ?? loaded;
	assert.equal(typeof PluginClass, 'function', 'main.js must export the plugin class');

	const plugin = new PluginClass(app);
	await plugin.onload();

	assert.equal(registered.extensions.length, 1, 'editor extension must be registered');
	assert.equal(registered.tabs.length, 1, 'settings tab must be registered');
	assert.ok(registered.commands.length >= 8, `expected >=8 commands, got ${registered.commands.length}`);
	const ids = new Set(registered.commands.map((c) => c.id));
	for (const id of [
		'accept-prediction',
		'accept-prediction-word',
		'accept-prediction-sentence',
		'accept-prediction-line',
		'dismiss-prediction',
		'predict-now',
		'toggle-prediction',
		'open-prediction-settings',
	]) {
		assert.ok(ids.has(id), `missing command: ${id}`);
	}
	assert.equal(plugin.settings.schemaVersion, 1, 'settings must be normalized on load');
	assert.equal(plugin.settings.completion.enabled, true, 'completion defaults to on');
	assert.equal(plugin.settings.semantic.enabled, false, 'semantic retrieval defaults to off');
	assert.equal(plugin.settings.learning.enabled, false, 'profile learning defaults to off');

	// Toggle command flips the master switch and persists it.
	const toggle = registered.commands.find((c) => c.id === 'toggle-prediction');
	await toggle.callback();
	assert.ok(saved.data !== null, 'toggle must persist settings');
	assert.equal(saved.data.completion.enabled, false, 'toggle must persist enabled=false');
	await toggle.callback();
	assert.equal(saved.data.completion.enabled, true, 'toggle must persist enabled=true');

	assert.equal(requestUrlCalls, 0, 'onload/toggle must not perform network calls');

	await plugin.onunload();
	console.log('smoke ok:', {
		commands: registered.commands.length,
		extensions: registered.extensions.length,
		settingsTabs: registered.tabs.length,
		networkCalls: requestUrlCalls,
	});
})().catch((error) => {
	console.error('smoke failed:', error);
	process.exitCode = 1;
});
