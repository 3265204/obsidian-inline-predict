/**
 * Collapsible settings groups.
 *
 * Settings keep growing, so secondary options live in `<details>` groups instead of one long
 * column. Open/closed state is remembered for the session (not persisted to the vault) so
 * switching tabs does not reset the layout; defaults keep the main workflow visible.
 */

import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n';

export interface CollapsibleOptions {
	title: TranslationKey;
	defaultOpen?: boolean;
	/** Optional one-line hint shown next to the group title. */
	description?: TranslationKey;
	cls?: string;
}

export interface CollapsibleGroup {
	details: HTMLDetailsElement;
	body: HTMLElement;
}

/** Session-scoped memory, keyed by i18n key so language switches do not reset the state. */
const remembered = new Map<string, boolean>();

export function addCollapsibleGroup(
	container: HTMLElement,
	options: CollapsibleOptions,
): CollapsibleGroup {
	const key = String(options.title);
	const details = container.createEl('details', {
		cls: options.cls ? `predictive-collapsible ${options.cls}` : 'predictive-collapsible',
	});
	details.open = remembered.get(key) ?? options.defaultOpen ?? false;

	const summary = details.createEl('summary', { cls: 'predictive-collapsible-summary' });
	summary.createSpan({ cls: 'predictive-collapsible-title', text: t(options.title) });
	if (options.description) {
		summary.createSpan({
			cls: 'predictive-collapsible-desc',
			text: t(options.description),
		});
	}

	const body = details.createDiv({ cls: 'predictive-collapsible-body' });
	details.addEventListener('toggle', () => remembered.set(key, details.open));
	return { details, body };
}
