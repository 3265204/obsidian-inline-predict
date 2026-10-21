import { t } from '../../i18n';
import type { SettingsSectionContext } from './host';
import { addNote, addNumber, addText, addToggle, applyPatch } from './shared';

/**
 * Semantic retrieval is off by default (ADR-005). The explainer is driven by the host's own
 * status so the UI can never claim semantic search is active when no provider/consent exists.
 * Provider details live in a collapsible group: they are irrelevant while the feature is off.
 */
export function renderSemanticSection(ctx: SettingsSectionContext): void {
	const { containerEl, host } = ctx;
	const { semantic, privacy } = host.getSettings();
	const status = host.getSemanticStatus();


	addToggle(containerEl, {
		name: 'settings.semantic.enabled.name',
		desc: 'settings.semantic.enabled.desc',
		value: semantic.enabled,
		onChange: async (value) => {
			await applyPatch(ctx, { semantic: { enabled: value } });
			ctx.refresh();
		},
	});

	// Explain the inactive state whenever the feature cannot run, whatever the reason.
	if (!status.enabled) {
		addNote(containerEl, t('settings.semantic.inactive'), 'predictive-status-line');
	} else if (!status.available) {
		addNote(containerEl, t('settings.semantic.noConsent'), 'predictive-status-line');
	}
	if (status.reason.length > 0) {
		// Host-provided detail (already localised by the plugin) appended for troubleshooting.
		addNote(containerEl, status.reason, 'predictive-status-detail');
	}

	const embedding = containerEl;

	addToggle(embedding, {
		name: 'settings.semantic.consent.name',
		desc: 'settings.semantic.consent.desc',
		value: privacy.remoteEmbeddingConsent,
		onChange: async (value) => {
			await applyPatch(ctx, { privacy: { remoteEmbeddingConsent: value } });
			ctx.refresh();
		},
	});

	addText(embedding, {
		name: 'settings.semantic.baseUrl.name',
		desc: 'settings.semantic.baseUrl.desc',
		value: semantic.embedding.baseUrl,
		placeholder: 'https://api.openai.com/v1',
		onChange: (value) => applyPatch(ctx, { semantic: { embedding: { baseUrl: value } } }),
	});

	addText(embedding, {
		name: 'settings.semantic.apiKey.name',
		desc: 'settings.semantic.apiKey.desc',
		value: semantic.embedding.apiKey,
		secret: true,
		onChange: (value) => applyPatch(ctx, { semantic: { embedding: { apiKey: value } } }),
	});

	addText(embedding, {
		name: 'settings.semantic.modelId.name',
		desc: 'settings.semantic.modelId.desc',
		value: semantic.embedding.modelId,
		placeholder: 'text-embedding-3-small',
		onChange: (value) => applyPatch(ctx, { semantic: { embedding: { modelId: value } } }),
	});

	addNumber(embedding, {
		name: 'settings.semantic.batchSize.name',
		desc: 'settings.semantic.batchSize.desc',
		value: semantic.embedding.batchSize,
		min: 1,
		max: 256,
		step: 1,
		onChange: (value) => applyPatch(ctx, { semantic: { embedding: { batchSize: value } } }),
	});
}
