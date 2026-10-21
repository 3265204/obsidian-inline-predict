/** English strings. Keep this the canonical key set; other locales must match it exactly. */
export const en = {
	'app.name': 'Inline Predict',

	'command.accept': 'Accept prediction',
	'command.acceptWord': 'Accept next word of prediction',
	'command.acceptSentence': 'Accept next sentence of prediction',
	'command.acceptLine': 'Accept next line of prediction',
	'command.reject': 'Dismiss prediction',
	'command.toggle': 'Toggle inline prediction',
	'command.search': 'Search notes with natural language',
	'command.diagnostics': 'Open prediction diagnostics',
	'command.predictNow': 'Predict now',
	'command.settings': 'Open Inline Predict settings',
	'common.cancel': 'Cancel',
	'ribbon.search': 'Inline Predict search',

	'status.enabled': 'Inline Predict: on',
	'status.disabled': 'Inline Predict: off',
	'status.modelNotConfigured': 'Inline Predict: model not configured',
	'status.requesting': 'Inline Predict: predicting…',
	'status.backoff': 'Inline Predict: waiting after an error',
	'status.ready': 'Inline Predict: ready',
	'status.cached': 'Inline Predict: cached',

	'notice.disabled': 'Inline prediction is turned off.',
	'notice.modelNotConfigured': 'Set a model id and API key in the Inline Predict settings first.',
	'notice.requestFailed': 'Prediction request failed: {message}',
	'notice.accepted': 'Prediction accepted.',
	'notice.statsReset': 'Prediction statistics reset.',
	'notice.indexRebuilt': 'Local index rebuilt.',
	'notice.cacheCleared': 'Caches cleared.',
	'notice.profileCleared': 'Writing profile cleared.',
	'notice.consentRequired':
		'Enable the privacy consent switch in settings before sending note text to a remote service.',
	'notice.partialOnly': 'Only part of the prediction could be shown.',
	'notice.notAvailable': 'This feature is not available in this build yet.',
	'notice.providerRequired': 'Enter an API key to enable predictions. Local OpenAI-compatible servers can use a placeholder key.',

	'ghost.acceptHint': 'Accept',
	'ghost.tapToAccept': 'Tap to accept the prediction',

	'settings.title': 'Inline Predict',
	'settings.intro.modelSetup':
		'Please fill in an OpenAI-compatible API base URL, API key and model ID under Model first so the plugin can work.',
	'settings.section.completion': 'Completion',
	'settings.section.model': 'Model',
	'settings.section.semantic': 'Semantic search',
	'settings.section.learning': 'Writing profile',
	'settings.section.data': 'Index and cache',
	'settings.section.diagnostics': 'Diagnostics',
	'settings.section.advanced': 'Advanced',

	'settings.completion.enabled.name': 'Inline predictions',
	'settings.completion.enabled.desc':
		'Master switch. When off, no ghost text is shown and no model requests are made; the options below are disabled.',
	'settings.completion.autoTrigger.name': 'Predict automatically while typing',
	'settings.completion.autoTrigger.desc':
		'When on, predictions are requested automatically while typing. When off, only the “Predict now” command triggers one: this substantially reduces token usage, but no suggestion appears while you type.',
	'settings.completion.debounce.name': 'Base pause before predicting (ms)',
	'settings.completion.debounce.desc':
		'Adjusts automatically with typing speed and document structure. Higher values reduce requests.',
	'settings.completion.minPrefix.name': 'Minimum context characters',
	'settings.completion.minPrefix.desc':
		'Do not predict on nearly empty documents. Context around the cursor must reach this length.',
	'settings.completion.maxChars.name': 'Maximum suggestion length (characters)',
	'settings.completion.maxChars.desc':
		'Safety ceiling only. Length is normally decided by the model stopping at a natural boundary.',
	'settings.completion.filterOffTopic.name': 'Filter unrelated suggestions',
	'settings.completion.judge.name': 'Model-check borderline suggestions',
	'settings.completion.judge.desc':
		'When the local relatedness check is unsure, ask the configured model one YES/NO relevance question. Only suspicious candidates trigger it, so it adds one small request and ~0.3–1 s latency in those rare cases.',
	'settings.completion.filterOffTopic.desc':
		'Reject long suggestions that share no term with a short Chinese context. Local check, no extra API call; prevents memorized boilerplate when the note has little context. Short continuations are never filtered.',

	'settings.model.baseUrl.name': 'API base URL',
	'settings.model.baseUrl.desc':
		'OpenAI-compatible endpoint, for example https://api.openai.com/v1. Embeddings are configured separately.',
	'settings.model.apiKey.name': 'API key',
	'settings.model.apiKey.desc':
		'Stored locally in this plugin’s data file in plain text. Never sent anywhere except your configured endpoint.',
	'settings.model.modelId.name': 'Model ID',
	'settings.model.modelId.desc': 'Model used for completion requests.',
	'settings.model.temperature.name': 'Temperature',
	'settings.model.temperature.desc': 'Lower values make completions more predictable.',
	'settings.model.maxOutputTokens.name': 'Maximum output tokens',
	'settings.model.maxOutputTokens.desc':
		'Safety limit for truncation handling. Reaching this limit is treated as a degraded result, not a normal stop.',
	'settings.model.timeout.name': 'Request timeout (ms)',
	'settings.model.timeout.desc': 'Abort and back off when a prediction takes too long.',
	'settings.model.contextWindow.name': 'Context window (tokens)',
	'settings.model.contextWindow.desc':
		'0 uses the adapter default. Used to size the prompt budget, not to send more text.',
	'settings.model.reasoningEffort.name': 'Reasoning effort',
	'settings.model.reasoningEffort.desc':
		'Optional provider parameter. Some reasoning models (e.g. DeepSeek V4 Flash) spend hidden tokens on reasoning before answering, which breaks inline prediction. Use “none” for those. Leave as provider default to omit the parameter completely.',
	'settings.model.reasoningEffort.default': 'Provider default (omit)',
	'settings.model.privacyNote':
		'When prediction is on, text around the cursor (plus optional related notes and profile) is sent to the provider above. With an empty API key or model id, no request is made.',
	'settings.model.test': 'Test connection',
	'settings.model.testSuccess': 'Connection works. Network latency {latency}',
	'settings.model.testFailure': 'Connection failed: {message}',
	'settings.model.testUnavailable': 'Connection testing is not available in this build.',

	'settings.semantic.enabled.name': 'Enable semantic retrieval',
	'settings.semantic.enabled.desc':
		'Find semantically related notes to improve context matching and reduce irrelevant content and wasted predictions. When off, keyword retrieval still works, but some situations may need more requests. Semantic retrieval itself can also incur embedding costs.',
	'settings.semantic.inactive':
		'Semantic retrieval is off. Keyword search over the vault remains available.',
	'settings.semantic.noConsent':
		'Semantic retrieval needs an embedding provider and explicit consent to send note chunks.',
	'settings.semantic.baseUrl.name': 'Embedding API base URL',
	'settings.semantic.baseUrl.desc':
		'Embeddings are often a different service from chat completions. Configure it independently.',
	'settings.semantic.apiKey.name': 'Embedding API key',
	'settings.semantic.apiKey.desc':
		'Only used for embedding requests. Separately configured from the completion key.',
	'settings.semantic.modelId.name': 'Embedding model ID',
	'settings.semantic.modelId.desc':
		'Vectors from different models are never mixed. Changing the model invalidates the vector index.',
	'settings.semantic.batchSize.name': 'Embedding batch size',
	'settings.semantic.batchSize.desc':
		'Chunks per request while building the index. Smaller batches are safer on mobile.',
	'settings.semantic.consent.name': 'Allow sending note chunks for embeddings',
	'settings.semantic.consent.desc':
		'Required before any note content is uploaded for embedding. Off by default.',

	'settings.learning.enabled.name': 'Learn my writing habits',
	'settings.learning.enabled.desc':
		'Build a local writing profile (style, structure, reasoning preferences) stored in the vault. Off by default. Nothing is uploaded; scanning uses local analysis only.',
	'settings.learning.scan': 'Build profile now',
	'settings.learning.scanning': 'Scanning notes… {done}/{total}',
	'settings.learning.cancel': 'Cancel scan',
	'settings.learning.notAvailable': 'Writing-profile features are not available in this build yet.',
	'settings.learning.mergedNote':
		'The profile is local and descriptive. Feature values record their source data so they can be audited.',
	'settings.learning.export': 'Export profile',
	'settings.learning.import': 'Import profile',
	'settings.learning.clear': 'Clear profile',
	'settings.learning.importFailed':
		'Import failed, existing profile kept. Reason: {message}',
	'settings.learning.importSuccess': 'Profile imported.',
	'settings.learning.exportSuccess': 'Profile exported to {path}.',

	'settings.data.rebuildIndex': 'Rebuild local index',
	'settings.data.rebuildIndex.desc':
		'Re-scan Markdown files and rebuild the keyword index. Hidden .predictive data is excluded.',
	'settings.data.clearCache': 'Clear caches',
	'settings.data.clearCache.desc':
		'Clear cached predictions and assembled context. Does not touch notes or the profile.',
	'settings.data.clearProfile': 'Clear writing profile',
	'settings.data.clearProfile.desc':
		'Deletes only the profile data. Disabling learning does not delete anything by itself.',
	'settings.data.storageNote':
		'Data lives under .predictive/ in this vault. Hidden folders are not encryption; some sync tools may still copy them.',

	'settings.diagnostics.requests': 'Completed prediction attempts',
	'settings.diagnostics.modelCalls': 'Model API calls (including relevance checks)',
	'settings.diagnostics.modelCallFailures': 'Failed model API calls',
	'settings.diagnostics.unknownUsage': 'Calls with unknown usage',
	'settings.diagnostics.unknown': 'Known usage only; some calls have no usage data',
	'settings.diagnostics.failures': 'Failed requests',
	'settings.diagnostics.cacheHits': 'Cache hits',
	'settings.diagnostics.prefixReuses': 'Prefix reuses',
	'settings.diagnostics.tokens': 'Input / output tokens',
	'settings.diagnostics.cachedTokens': 'Cached input tokens',
	'settings.diagnostics.offTopic': 'Off-topic filtered',
	'settings.diagnostics.latency': 'Latency p50 / p95',
	'settings.diagnostics.acceptRate': 'Accept rate',
	'settings.diagnostics.partialAcceptRate': 'Partial accept rate',
	'settings.diagnostics.tokensPerAccept': 'Tokens per accepted suggestion',
	'settings.diagnostics.cost': 'Estimated cost',
	'settings.diagnostics.estimated': 'estimated',
	'settings.diagnostics.reported': 'from provider usage',
	'settings.diagnostics.reset': 'Reset statistics',
	'settings.diagnostics.noData': 'No predictions yet.',
	'settings.diagnostics.localOnly':
		'All statistics stay on this device. Nothing is uploaded.',

	'settings.advanced.cacheEntries.name': 'Prediction cache entries',
	'settings.advanced.cacheEntries.desc':
		'How many unused predictions to keep in memory for prefix reuse.',
	'settings.advanced.contextEntries.name': 'Context cache entries',
	'settings.advanced.contextEntries.desc':
		'How many parsed document/section contexts to keep.',
	'settings.advanced.debug.name': 'Verbose local logging',
	'settings.advanced.debug.desc':
		'Log scheduling and validation decisions to the developer console. No data leaves the device.',
	'settings.advanced.resetAll': 'Reset all settings to defaults',
	'settings.advanced.resetConfirm': 'Reset all Inline Predict settings to defaults?',

	'search.title': 'Inline Predict search',
	'search.placeholder': 'Ask in natural language, e.g. “where did I discuss matrix similarity?”',
	'search.run': 'Search',
	'search.results': '{count} results',
	'search.noResults': 'No matching notes found.',
	'search.semanticOff': 'Keyword search only. Enable semantic retrieval in settings for more.',
	'search.semanticPending': 'Semantic retrieval is not active yet.',
	'search.match': 'Match',
	'search.open': 'Open at position',
	'search.emptyQuery': 'Type a query to search your vault.',
	'search.indexing': 'Index is building… {done}/{total}',

	'error.modelNotConfigured': 'No model is configured.',
	'error.timeout': 'The prediction request timed out.',
	'error.auth': 'The provider rejected the API key.',
	'error.rateLimit': 'The provider rate limit was hit. Retrying later.',
	'error.network': 'Network error while contacting the provider.',
	'error.invalidResponse': 'The provider returned an unexpected response.',
	'error.truncated': 'The prediction was cut off by the output limit.',
	'error.aborted': 'The prediction request was cancelled.',
} as const;
