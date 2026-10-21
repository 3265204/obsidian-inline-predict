/**
 * Shared widgets for the settings tab.
 *
 * All user-visible copy comes from i18n keys passed by the section renderers. The helpers are
 * plain functions (not base classes) so each section file stays small and readable.
 */

import { Notice, Setting } from 'obsidian';
import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import type { DeepPartial, PredictiveSettings } from '../../settings/schema';
import { ConfirmModal } from './confirm-modal';
import type { SettingsSectionContext } from './host';

export interface ToggleOptions {
	name: TranslationKey;
	desc?: TranslationKey;
	value: boolean;
	onChange: (value: boolean) => void | Promise<void>;
}

export function addToggle(container: HTMLElement, options: ToggleOptions): Setting {
	const setting = new Setting(container).setName(t(options.name));
	if (options.desc) setting.setDesc(t(options.desc));
	return setting.addToggle((toggle) => {
		toggle.setValue(options.value);
		toggle.onChange((value) => void options.onChange(value));
	});
}

export interface TextOptions {
	name: TranslationKey;
	desc?: TranslationKey;
	value: string;
	placeholder?: string;
	/** Render a password-style input with a reveal toggle (for API keys). */
	secret?: boolean;
	onChange: (value: string) => void | Promise<void>;
}

export function addText(container: HTMLElement, options: TextOptions): Setting {
	const setting = new Setting(container).setName(t(options.name));
	if (options.desc) setting.setDesc(t(options.desc));
	if (options.secret) {
		let inputEl: HTMLInputElement | null = null;
		setting
			.addText((text) => {
				inputEl = text.inputEl;
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.setValue(options.value);
				text.onChange((value) => void options.onChange(value));
			})
			.addExtraButton((button) => {
				button.setIcon('eye').setTooltip(t(options.name));
				button.onClick(() => {
					if (inputEl) inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
				});
			});
		return setting;
	}
	return setting.addText((text) => {
		if (options.placeholder) text.setPlaceholder(options.placeholder);
		text.setValue(options.value);
		text.onChange((value) => void options.onChange(value));
	});
}

export interface NumberOptions {
	name: TranslationKey;
	desc?: TranslationKey;
	value: number;
	min: number;
	max: number;
	step?: number;
	integer?: boolean;
	onChange: (value: number) => void | Promise<void>;
}

/**
 * Numeric text input. Commits on `change` (blur/Enter) rather than on every keystroke so a
 * partially typed value (e.g. the `4` of `4000`) never reaches the settings file.
 */
export function addNumber(container: HTMLElement, options: NumberOptions): Setting {
	const setting = new Setting(container).setName(t(options.name));
	if (options.desc) setting.setDesc(t(options.desc));
	return setting.addText((text) => {
		const rounded = options.integer === false ? options.value : Math.round(options.value);
		const commit = (): void => {
			const parsed = Number(text.inputEl.value);
			if (!Number.isFinite(parsed)) {
				text.setValue(String(rounded));
				return;
			}
			const value = Math.min(options.max, Math.max(options.min, parsed));
			const normalized = options.integer === false ? value : Math.round(value);
			text.setValue(String(normalized));
			void options.onChange(normalized);
		};
		text.inputEl.type = 'number';
		text.inputEl.min = String(options.min);
		text.inputEl.max = String(options.max);
		text.inputEl.step = String(options.step ?? 1);
		text.inputEl.inputMode = options.integer === false ? 'decimal' : 'numeric';
		text.setValue(String(rounded));
		text.inputEl.addEventListener('change', commit);
	});
}

export interface SliderOptions {
	name: TranslationKey;
	desc?: TranslationKey;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void | Promise<void>;
}

export function addSlider(container: HTMLElement, options: SliderOptions): Setting {
	const setting = new Setting(container).setName(t(options.name));
	if (options.desc) setting.setDesc(t(options.desc));
	return setting.addSlider((slider) => {
		slider.setLimits(options.min, options.max, options.step);
		slider.setValue(options.value);
		// Supported since Obsidian 0.9.7 (minimum we target). Newer builds show the value inline
		// anyway; keeping this call makes the value visible on older app versions.
		slider.setDynamicTooltip();
		slider.onChange((value) => void options.onChange(value));
	});
}

/** Muted explanatory paragraph attached to a section (not a Setting row). */
export function addNote(container: HTMLElement, text: string, cls = 'predictive-note'): HTMLElement {
	return container.createEl('p', { text, cls });
}

/** Human-readable message for an unknown thrown value (adapter/model errors are `unknown`). */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return String(error);
}

export function notifyError(error: unknown): void {
	new Notice(t('notice.requestFailed', { message: errorMessage(error) }));
}

/** Apply a settings patch and surface failures instead of leaving the UI out of sync silently. */
export async function applyPatch(
	ctx: SettingsSectionContext,
	patch: DeepPartial<PredictiveSettings>,
): Promise<void> {
	try {
		await ctx.host.updateSettings(patch);
	} catch (error) {
		notifyError(error);
	}
}

export interface ConfirmOptions {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
}

/**
 * Confirmation for destructive actions. The modal has no separate "cancel" button: Obsidian's
 * modal chrome already closes on Escape/outside click, and the confirm action is the only
 * button that does anything. `onConfirm` must handle its own async errors.
 */
export function confirmAction(ctx: SettingsSectionContext, options: ConfirmOptions): void {
	new ConfirmModal(ctx.app, options).open();
}

/* ------------------------------------------------------------------ */
/* Number formatting for the diagnostics grid                          */
/* ------------------------------------------------------------------ */

export function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
}

export function formatPercent(numerator: number, denominator: number): string {
	if (!Number.isFinite(numerator) || denominator <= 0) return '—';
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function formatLatency(value: number): string {
	return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

export function formatCost(value: number | null): string {
	return value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(4)}`;
}
