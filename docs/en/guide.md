# User guide

[中文](../zh-CN/guide.md) · [Project overview](../../README.en.md)

## Install and configure

1. Download `main.js`, `manifest.json` and `styles.css` from the plugin's GitHub Release when available.
2. Copy the files into `<Vault>/.obsidian/plugins/inline-predict/`, reload Obsidian and enable Inline Predict.
3. Open **Settings → Inline Predict → Model** and enter your OpenAI-compatible base URL, key and model ID.
4. Use **Test connection**, then try a continuation in a test note.

Use a base URL such as `https://api.openai.com/v1`; do not append `/chat/completions`.
Keyless local servers still require a placeholder key such as `local`. Reasoning effort is optional
and must be supported by your provider. The connection test sends a fixed short prompt without note
content; its elapsed time includes network and server processing.

## Completion controls

- Automatic prediction considers requests after 2 prefix characters by default. Named notes and
  untitled buffers use the same threshold; existing saved settings retain their values.
- Fast typing stretches the wait. Sentence/paragraph boundaries and recent response times influence it.
- **Tab** accepts the full suggestion; **Esc** dismisses it. Without a suggestion both retain normal behavior.
- Commands accept the next word/character, sentence or line. Han and Kana partial word acceptance
  advances one code point at a time; it is not Japanese word segmentation.
- **Predict now** bypasses the prefix threshold, while retaining the master switch, IME protection and backoff.
- Disable automatic prediction to request suggestions only through the manual command.

Matching typed text reuses the remainder. Changing original context or model settings invalidates
old candidates. Suggestions are hidden during IME composition and appear only after non-streaming
generation completes.

## Privacy and usage

Predictions send bounded cursor-adjacent note text to your chosen provider. An optional relevance
check may send a small context/candidate pair in another call. Local relevance filtering covers
specific short Han-character contexts, not every language or pure Kana.

Keys are stored in plain text in the plugin's `data.json`. Consider this when syncing settings.
There is no telemetry upload or whole-vault scan. Retrieval and writing-profile learning are not
implemented in this build.

Diagnostics separate completed prediction attempts from actual model calls, including relevance
checks. Provider usage, estimates and calls with unknown usage are labelled separately. Stale
results are not displayed, but their known usage is retained. Cancellation does not guarantee
that the provider stops processing or billing. Counters reset when the plugin reloads.

Repeated partial acceptance counts as one accepted candidate for the acceptance rate. Latency
excludes the wait before requesting a prediction. Missing usage is not treated as zero cost.

## Compatibility

The current release is a preview. Windows, Linux, iOS, Android and the declared minimum Obsidian
version are not fully device-verified. Mobile touch controls are implemented, but keyboard/IME
behavior needs real-device testing. Multi-line ghost wrapping may differ from inserted text.

## Troubleshooting

**No suggestions:** check the master and automatic switches, try **Predict now**, and review
diagnostics. An empty or filtered continuation is a valid result. Successful connection tests do
not prove that longer completion requests fit the provider's limits.

**Timeouts or empty responses:** verify model ID and supported parameters. Reasoning models may
spend the output budget before producing visible text. Follow your provider's guidance for the
reasoning setting, output limit and timeout.

**Unexpected text:** dismiss it and provide reproduction steps without keys or private note content.
The plugin cannot guarantee factual accuracy. There is currently no path exclusion list; disable
prediction before working on notes you do not want sent to a model provider.
