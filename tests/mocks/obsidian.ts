/**
 * Minimal Obsidian runtime stub for unit tests.
 *
 * Vitest aliases `obsidian` to this file. Pure modules never import it, but adapters
 * (storage, model transport, settings UI) do, and tests need deterministic stand-ins for
 * `Platform`, `requestUrl`, `Notice`, and the vault DataAdapter.
 *
 * Only add what tests actually use; keep it dependency-free.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class Component {
	loaded = false;
	onload(): void {}
	onunload(): void {}
	load(): void {
		this.loaded = true;
		this.onload();
	}
	unload(): void {
		this.loaded = false;
		this.onunload();
	}
	register(): void {}
	registerEvent(): void {}
	registerDomEvent(): void {}
	registerInterval(): void {}
}

export class Plugin extends Component {
	app: any;
	manifest = { id: 'inline-predict', version: '0.1.1' };
	constructor(app?: any) {
		super();
		this.app = app;
	}
	addCommand(_command: unknown): unknown {
		return {};
	}
	addRibbonIcon(_icon: string, _title: string, _cb: unknown): HTMLElement {
		return {} as HTMLElement;
	}
	addStatusBarItem(): HTMLElement {
		return {} as HTMLElement;
	}
	addSettingTab(_tab: unknown): void {}
	registerView(_type: string, _factory: unknown): void {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;
	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = { empty: () => {}, createEl: () => ({}) };
	}
	display(): void {}
	update(): void {}
	hide(): void {}
}

export class Setting {
	settingEl!: HTMLElement;
	constructor(containerEl: unknown) {
		if (typeof document !== 'undefined' && containerEl instanceof HTMLElement) {
			this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
		}
	}
	setName(_name: string): this {
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	setDisabled(_v: boolean): this {
		return this;
	}
	setClass(_cls: string): this {
		return this;
	}
	addText(_cb: (component: any) => void): this {
		return this;
	}
	addTextArea(_cb: (component: any) => void): this {
		return this;
	}
	addToggle(_cb: (component: any) => void): this {
		return this;
	}
	addDropdown(_cb: (component: any) => void): this {
		return this;
	}
	addSlider(_cb: (component: any) => void): this {
		return this;
	}
	addButton(_cb: (component: any) => void): this {
		return this;
	}
	addExtraButton(_cb: (component: any) => void): this {
		return this;
	}
}

export class Notice {
	message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
	}
	hide(): void {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
}

export class Modal {
	app: any;
	containerEl: any;
	constructor(app: any) {
		this.app = app;
		this.containerEl = {};
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class ItemView extends Component {
	app: any;
	leaf: any;
	contentEl: any;
	constructor(leaf: any) {
		super();
		this.app = leaf?.app;
		this.leaf = leaf;
		this.contentEl = {};
	}
	getViewType(): string {
		return 'predictive-search';
	}
	getDisplayText(): string {
		return 'Inline Predict search';
	}
}

export class WorkspaceLeaf {
	app: any;
	view: any = null;
	constructor(app?: any) {
		this.app = app;
	}
	async setViewState(_state: unknown): Promise<void> {}
}

export class MarkdownView {
	app: any;
	editor: any;
	constructor(app?: any) {
		this.app = app;
	}
	getMode(): string {
		return 'source';
	}
}

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat = { mtime: 0, ctime: 0, size: 0 };
	constructor(path: string) {
		this.path = path;
		const parts = path.split('/');
		this.name = parts[parts.length - 1] ?? path;
		const dot = this.name.lastIndexOf('.');
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
	}
}

export class TFolder {
	path: string;
	constructor(path = '/') {
		this.path = path;
	}
}

export class Vault {
	adapter: any;
	constructor(adapter?: any) {
		this.adapter = adapter;
	}
	getMarkdownFiles(): TFile[] {
		return [];
	}
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
};

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export function debounce<T extends (...args: any[]) => unknown>(fn: T, _timeout = 0, _resetTimer = false): T {
	return fn;
}

/** Default stub; tests that exercise the transport replace it explicitly. */
export async function requestUrl(_request: unknown): Promise<{ status: number; text: string; json: unknown }> {
	throw new Error('requestUrl is not mocked in this test');
}

export class DataAdapter {
	async exists(_path: string): Promise<boolean> {
		return false;
	}
	async read(_path: string): Promise<string> {
		throw new Error('not found');
	}
	async write(_path: string, _data: string): Promise<void> {}
	async mkdir(_path: string): Promise<void> {}
	async remove(_path: string): Promise<void> {}
	async rename(_from: string, _to: string): Promise<void> {}
	async list(_path: string): Promise<{ files: string[]; folders: string[] }> {
		return { files: [], folders: [] };
	}
	async stat(_path: string): Promise<{ mtime: number; size: number } | null> {
		return null;
	}
}

export const moment = {
	locale: (): string => 'en',
};

export const activeDocument = {
	addEventListener: (): void => {},
	removeEventListener: (): void => {},
	createElement: (): any => ({}),
};

export const activeWindow = {
	setTimeout: (handler: () => void, timeout?: number): number => setTimeout(handler, timeout) as unknown as number,
	clearTimeout: (id: number): void => clearTimeout(id),
	setInterval: (handler: () => void, timeout?: number): number => setInterval(handler, timeout) as unknown as number,
	clearInterval: (id: number): void => clearInterval(id),
};
