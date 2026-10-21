/**
 * Composition root.
 *
 * Responsibilities (and nothing else): plugin lifecycle, settings persistence, constructing the
 * model/context/scheduler stack, registering the CM6 extension, commands, status bar and the
 * settings tab. All feature logic lives in the modules under `src/`.
 */

import {
	MarkdownView,
	Notice,
	Plugin,
	editorInfoField,
	editorLivePreviewField,
	getLanguage,
	moment,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { MIN_REQUEST_INTERVAL_MS } from './core/constants';
import type {
	DiagnosticsSnapshot,
	EditorMode,
	ModelAdapter,
	ModelErrorKind,
	SchedulerStatus,
	SuggestionFeedback,
} from './core/types';
import { resolveLocale, setLocale, t } from './i18n';
import { createCompletionIntegration } from './completion/controller';
import type { CompletionIntegration } from './completion/controller';
import { ContextEngine } from './context/context-engine';
import { testModelConnection } from './model/connection-test';
import { OpenAICompatibleAdapter } from './model/openai-chat';
import { PredictionEngine } from './prediction/engine';
import { ModelRelevanceJudge } from './prediction/relevance-judge';
import { CompletionScheduler } from './scheduler/scheduler';
import type { SchedulerConfig } from './scheduler/scheduler';
import { LruPredictionCache } from './scheduler/prediction-cache';
import { VaultStorage } from './storage/vault-storage';
import type { VaultAdapterLike } from './storage/types';
import { Telemetry } from './telemetry/stats';
import { PredictiveSettingTab } from './ui/settings-tab';
import type { SettingsHost } from './ui/settings-tab';
import { createPredictionStack } from './plugin/runtime';
import { applySettingsPatch, isCompletionConfigured, isEmbeddingConfigured, normalizeSettings } from './settings/schema';
import { predictionRuntimeChanged } from './settings/runtime';
import type { DeepPartial, PredictiveSettings } from './settings/schema';

export default class PredictivePlugin extends Plugin {
	settings!: PredictiveSettings;

	private readonly telemetry = new Telemetry();
	private readonly stack = createPredictionStack();
	private cache!: LruPredictionCache;
	private storage!: VaultStorage;
	private adapter: ModelAdapter | null = null;
	private integration: CompletionIntegration | null = null;
	private statusBarEl: HTMLElement | null = null;
	private schedulerStatus: SchedulerStatus = 'idle';
	private configurationVersion = 0;

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		setLocale(
			resolveLocale([
				this.readAppLanguage(),
				this.readMomentLocale(),
				this.readNavigatorLanguage(),
			]),
		);

		this.cache = new LruPredictionCache({ maxEntries: this.settings.advanced.cacheEntries });
		this.storage = new VaultStorage(this.app.vault.adapter as unknown as VaultAdapterLike);
		this.rebuildPredictionStack();

		this.integration = createCompletionIntegration({
			createScheduler: (events) =>
				new CompletionScheduler({
					contextBuilder: this.stack.contextBuilder,
					runner: this.stack.runner,
					cache: this.cache,
					telemetry: this.telemetry,
					getConfig: () => this.schedulerConfig(),
					events,
				}),
			getSettings: () => this.settings,
			getDocInfo: (view) => this.getDocInfo(view),
			onStatus: (status) => {
				this.schedulerStatus = status;
				this.updateStatusBar();
			},
			onNotice: (message) => new Notice(message),
			onFeedback: (event) => this.handleFeedback(event),
			onActiveController: () => this.updateStatusBar(),
		});
		this.registerEditorExtension(this.integration.extension);

		this.addSettingTab(new PredictiveSettingTab(this.app, this, this.createSettingsHost()));
		this.registerCommands();
		this.initStatusBar();

		// Warm context entries are keyed by vault path. Renames/deletes would otherwise leave
		// unreachable entries behind (they are bounded by LRU, but this keeps diagnostics honest).
		this.registerEvent(
			this.app.vault.on('rename', (_file, oldPath) => {
				this.stack.contextBuilder.invalidate(oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.stack.contextBuilder.invalidate(file.path);
			}),
		);

		// Create the hidden data directory lazily: only when a feature that persists data is on.
		if (this.settings.learning.enabled) {
			void this.storage.ensureDir().catch(() => undefined);
		}
	}

	onunload(): void {
		this.integration?.destroy();
		this.integration = null;
		this.stack.runner.set(null);
		this.stack.contextBuilder.set(null);
		this.cache?.clear();
		this.adapter = null;
	}

	/* ------------------------------------------------------------------ */
	/* Wiring helpers                                                      */
	/* ------------------------------------------------------------------ */

	private readAppLanguage(): string | undefined {
		try {
			// `getLanguage` exists since Obsidian 1.8.7; guard for older apps declared by minAppVersion.
			if (typeof getLanguage === 'function') return getLanguage();
		} catch {
			// Fall through to moment/navigator.
		}
		return undefined;
	}

	private readMomentLocale(): string | undefined {
		try {
			return moment.locale();
		} catch {
			return undefined;
		}
	}

	private readNavigatorLanguage(): string | undefined {
		try {
			return navigator.language;
		} catch {
			return undefined;
		}
	}

	private isProviderReady(): boolean {
		// A configured model without any key would still cause network traffic (and a 401) on the
		// first keystroke. Requiring a key keeps a fresh install completely offline.
		return isCompletionConfigured(this.settings) && this.settings.provider.apiKey.trim().length > 0;
	}

	private rebuildPredictionStack(): void {
		if (!this.isProviderReady()) {
			this.adapter = null;
			this.stack.runner.set(null);
			this.stack.contextBuilder.set(null);
			return;
		}
		const { provider, completion, advanced } = this.settings;
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			modelId: provider.modelId,
			contextWindow: provider.contextWindow > 0 ? provider.contextWindow : undefined,
			temperature: provider.temperature,
			maxOutputTokens: provider.maxOutputTokens,
			timeoutMs: provider.timeoutMs,
			reasoningEffort: provider.reasoningEffort,
		});
		const runner = new PredictionEngine({
			adapter,
			maxSuggestionChars: completion.maxSuggestionChars,
			tokenCounter: adapter.tokenCounter,
			offTopicFilter: completion.filterOffTopic,
			relevanceJudge: completion.verifyOffTopicWithModel
				? new ModelRelevanceJudge(adapter)
				: undefined,
		});
		const contextBuilder = new ContextEngine({
			modelContextWindow: provider.contextWindow > 0 ? provider.contextWindow : adapter.contextWindow,
			maxOutputTokens: provider.maxOutputTokens,
			tokenCounter: adapter.tokenCounter,
			warmCacheEntries: advanced.contextCacheEntries,
		});
		this.adapter = adapter;
		this.stack.runner.set(runner);
		this.stack.contextBuilder.set(contextBuilder);
	}

	private schedulerConfig(): SchedulerConfig {
		const { provider, completion, advanced } = this.settings;
		return {
			configurationVersion: this.configurationVersion,
			baseDebounceMs: completion.baseDebounceMs,
			minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
			maxOutputTokens: provider.maxOutputTokens,
			requestTimeoutMs: provider.timeoutMs,
			temperature: provider.temperature,
			cacheEntries: advanced.cacheEntries,
			contextCacheEntries: advanced.contextCacheEntries,
			debug: advanced.debugLogging,
			enabled: completion.enabled,
			autoTrigger: completion.autoTrigger,
			minPrefixChars: completion.minPrefixChars,
		};
	}

	private getDocInfo(view: EditorView): {
		docId: string;
		mode: EditorMode;
		language: string | null;
	} {
		try {
			const info = view.state.field(editorInfoField, false);
			const file = info?.file ?? null;
			const live = view.state.field(editorLivePreviewField, false) === true;
			const extension = file !== null && file.extension.length > 0 ? file.extension : 'md';
			return {
				docId: file?.path ?? '',
				mode: live ? 'live' : 'source',
				language: extension === 'md' ? 'markdown' : extension,
			};
		} catch {
			// The field is absent in non-markdown editors or during teardown.
			return { docId: '', mode: 'source', language: null };
		}
	}

	private handleFeedback(event: SuggestionFeedback): void {
		if (event.type === 'ignored') this.telemetry.recordIgnored();
		// 接受与拒绝由调度器统计，超时或编辑导致的忽略由控制器反馈。
		if (this.settings.advanced.debugLogging) {
			console.debug('[predictive] feedback', event.type);
		}
	}

	private createSettingsHost(): SettingsHost {
		return {
			getSettings: () => this.settings,
			updateSettings: (patch: DeepPartial<PredictiveSettings>) => this.updateSettings(patch),
			getDiagnostics: (): DiagnosticsSnapshot => this.telemetry.snapshot(),
			rebuildIndex: async () => {
				// M4 owns the retrieval index; do not pretend it was rebuilt.
				new Notice(t('notice.notAvailable'));
			},
			clearCaches: async () => {
				this.cache.clear();
				this.stack.contextBuilder.invalidate();
				await this.storage.remove('.predictive/cache').catch(() => undefined);
				new Notice(t('notice.cacheCleared'));
			},
			exportProfile: async () => {
				// M6 owns the writing profile. An empty string means "no profile yet".
				return '';
			},
			importProfile: async () => {
				throw new Error(t('notice.notAvailable'));
			},
			clearProfile: async () => {
				new Notice(t('notice.notAvailable'));
			},
			testConnection: () => this.runConnectionTest(),
			getSemanticStatus: () => this.semanticStatus(),
		};
	}

	/**
	 * Minimal live check used by Settings → Model → Test connection. Sends a fixed "ping" prompt
	 * (no note content) with the current provider settings; failures are mapped to localized
	 * messages. The request is intentionally excluded from prediction statistics.
	 */
	private async runConnectionTest(): Promise<{ ok: boolean; message: string }> {
		const { provider } = this.settings;
		if (provider.baseUrl.trim().length === 0 || provider.modelId.trim().length === 0) {
			return { ok: false, message: t('notice.modelNotConfigured') };
		}
		const adapter = new OpenAICompatibleAdapter({
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			modelId: provider.modelId,
			contextWindow: provider.contextWindow > 0 ? provider.contextWindow : undefined,
			temperature: provider.temperature,
			maxOutputTokens: provider.maxOutputTokens,
			timeoutMs: provider.timeoutMs,
			reasoningEffort: provider.reasoningEffort,
		});
		const result = await testModelConnection(adapter, {
			timeoutMs: Math.min(provider.timeoutMs, 10_000),
		});
		if (result.ok) return { ok: true, message: `${result.latencyMs} ms` };
		return { ok: false, message: this.describeModelError(result.errorKind, result.message) };
	}

	private describeModelError(kind: ModelErrorKind | undefined, raw: string | undefined): string {
		switch (kind) {
			case 'auth':
				return t('error.auth');
			case 'rate-limit':
				return t('error.rateLimit');
			case 'timeout':
				return t('error.timeout');
			case 'aborted':
				return t('error.aborted');
			case 'server':
			case 'network':
				return t('error.network');
			case 'invalid-response':
				return t('error.invalidResponse');
			case 'configuration':
				return t('notice.modelNotConfigured');
			default:
				return raw !== undefined && raw.trim().length > 0 ? raw : t('error.network');
		}
	}

	private semanticStatus(): { enabled: boolean; available: boolean; reason: string } {
		const { semantic } = this.settings;
		if (!semantic.enabled) {
			return { enabled: false, available: false, reason: t('settings.semantic.inactive') };
		}
		if (!isEmbeddingConfigured(this.settings)) {
			return { enabled: true, available: false, reason: t('settings.semantic.noConsent') };
		}
		// Configured + consented, but the retrieval/embedding pipeline ships in M5.
		return { enabled: true, available: false, reason: t('search.semanticPending') };
	}

	private async updateSettings(patch: DeepPartial<PredictiveSettings>): Promise<void> {
		const previous = this.settings;
		this.settings = applySettingsPatch(previous, patch);
		this.cache.setMaxEntries(this.settings.advanced.cacheEntries);
		if (predictionRuntimeChanged(previous, this.settings)) {
			this.configurationVersion++;
			this.cache.clear();
			this.rebuildPredictionStack();
		}
		this.integration?.refresh();
		this.updateStatusBar();
		await this.saveData(this.settings);
	}

	/* ------------------------------------------------------------------ */
	/* Status bar & commands                                               */
	/* ------------------------------------------------------------------ */

	private initStatusBar(): void {
		try {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass('predictive-status');
		} catch {
			this.statusBarEl = null;
		}
		this.updateStatusBar();
	}

	private updateStatusBar(): void {
		if (this.statusBarEl === null) return;
		const text = this.statusText();
		this.statusBarEl.setText(text);
		this.statusBarEl.setAttribute('aria-label', text);
	}

	private statusText(): string {
		if (!this.settings.completion.enabled) return t('status.disabled');
		if (!this.isProviderReady()) return t('status.modelNotConfigured');
		switch (this.schedulerStatus) {
			case 'requesting':
				return t('status.requesting');
			case 'cached':
				return t('status.cached');
			case 'backoff':
				return t('status.backoff');
			case 'disabled':
				return t('status.disabled');
			default:
				return t('status.ready');
		}
	}

	private registerCommands(): void {
		const withMarkdownView = (checking: boolean, action: () => boolean | void): boolean => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view === null) return false;
			if (!checking) action();
			return true;
		};

		this.addCommand({
			id: 'accept-prediction',
			name: t('command.accept'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => this.integration?.acceptAll()),
		});
		this.addCommand({
			id: 'accept-prediction-word',
			name: t('command.acceptWord'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => this.integration?.acceptWord()),
		});
		this.addCommand({
			id: 'accept-prediction-sentence',
			name: t('command.acceptSentence'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => this.integration?.acceptSentence()),
		});
		this.addCommand({
			id: 'accept-prediction-line',
			name: t('command.acceptLine'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => this.integration?.acceptLine()),
		});
		this.addCommand({
			id: 'dismiss-prediction',
			name: t('command.reject'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => this.integration?.dismiss()),
		});
		this.addCommand({
			id: 'predict-now',
			name: t('command.predictNow'),
			checkCallback: (checking) =>
				withMarkdownView(checking, () => {
					if (!this.isProviderReady()) {
						new Notice(t('notice.modelNotConfigured'));
						return;
					}
					this.integration?.requestNow();
				}),
		});
		this.addCommand({
			id: 'toggle-prediction',
			name: t('command.toggle'),
			callback: () => {
				void this.updateSettings({
					completion: { enabled: !this.settings.completion.enabled },
				}).then(() => {
					new Notice(
						this.settings.completion.enabled ? t('status.enabled') : t('status.disabled'),
					);
				});
			},
		});
		this.addCommand({
			id: 'open-prediction-settings',
			name: t('command.settings'),
			callback: () => this.openSettings(),
		});
	}

	private openSettings(): void {
		const app = this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		};
		app.setting?.open();
		app.setting?.openTabById(this.manifest.id);
	}
}
