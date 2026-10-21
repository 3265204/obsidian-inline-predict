import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import type { SettingsSectionContext } from './host';
import {
	addNote,
	formatCost,
	formatInteger,
	formatLatency,
	formatPercent,
} from './shared';

function addRow(grid: HTMLElement, label: TranslationKey, value: string, tag?: string): void {
	grid.createDiv({ cls: 'predictive-diagnostics-label', text: t(label) });
	const valueEl = grid.createDiv({ cls: 'predictive-diagnostics-value', text: value });
	if (tag) valueEl.createSpan({ cls: 'predictive-diagnostics-tag', text: tag });
}

/**
 * Read-only local statistics. Estimated values are labelled as such: provider-reported usage is
 * authoritative, the local heuristic is not (ADR-006).
 */
export function renderDiagnosticsSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const stats = host.getDiagnostics();
	const accepted = stats.fullAccepts + stats.partialAccepts;
	const totalTokens = stats.inputTokens + stats.outputTokens;


	if (stats.requests === 0) {
		addNote(containerEl, t('settings.diagnostics.noData'), 'predictive-status-line');
	}

	const usageTag =
		stats.requests === 0
			? undefined
			: stats.unknownUsageCalls > 0
				? t('settings.diagnostics.unknown')
			: stats.estimatedUsageRequests > 0
				? t('settings.diagnostics.estimated')
				: t('settings.diagnostics.reported');

	const grid = containerEl.createDiv({ cls: 'predictive-diagnostics-grid' });
	addRow(grid, 'settings.diagnostics.requests', formatInteger(stats.requests));
	addRow(grid, 'settings.diagnostics.modelCalls', formatInteger(stats.modelCalls));
	addRow(grid, 'settings.diagnostics.modelCallFailures', formatInteger(stats.modelCallFailures));
	addRow(grid, 'settings.diagnostics.unknownUsage', formatInteger(stats.unknownUsageCalls));
	addRow(grid, 'settings.diagnostics.failures', formatInteger(stats.requestFailures));
	addRow(grid, 'settings.diagnostics.cacheHits', formatInteger(stats.cacheHits));
	addRow(grid, 'settings.diagnostics.prefixReuses', formatInteger(stats.prefixReuses));
	addRow(
		grid,
		'settings.diagnostics.tokens',
		`${formatInteger(stats.inputTokens)} / ${formatInteger(stats.outputTokens)}`,
		usageTag,
	);
	addRow(grid, 'settings.diagnostics.cachedTokens', formatInteger(stats.cachedInputTokens));
	addRow(grid, 'settings.diagnostics.offTopic', formatInteger(stats.offTopicRejections));
	addRow(
		grid,
		'settings.diagnostics.latency',
		stats.latency.count === 0
			? '—'
			: `${formatLatency(stats.latency.p50)} / ${formatLatency(stats.latency.p95)}`,
	);
	addRow(grid, 'settings.diagnostics.acceptRate', formatPercent(stats.acceptedSuggestions, stats.candidatesShown));
	addRow(
		grid,
		'settings.diagnostics.partialAcceptRate',
		formatPercent(stats.partialAccepts, accepted),
	);
	addRow(
		grid,
		'settings.diagnostics.tokensPerAccept',
		stats.acceptedSuggestions === 0 ? '—' : formatInteger(totalTokens / stats.acceptedSuggestions),
	);
	addRow(
		grid,
		'settings.diagnostics.cost',
		formatCost(stats.estimatedCostUsd),
		t('settings.diagnostics.estimated'),
	);

	addNote(containerEl, t('settings.diagnostics.localOnly'));

	// No reset control: SettingsHost has no reset method, and the tab must not reach into the
	// telemetry module directly. Add it once the host exposes `resetDiagnostics()`.
}
