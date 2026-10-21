# Inline Predict — inline AI completion for Obsidian

[中文](README.md) · [English guide](docs/en/guide.md) · [User guide (中文)](docs/zh-CN/guide.md)

Inline Predict previews continuations as grey text inside the Markdown editor. Press **Tab** to accept,
**Esc** to dismiss, or use commands to accept a word/character, sentence or line. Suggestions do not
modify the note until accepted.

**Version 0.1.0 — beta.**

## Install and configure

Download `main.js`, `manifest.json` and `styles.css` from GitHub Releases when available.
The automatically generated Source code archive is not an installable plugin package. Copy the three files into
`<Vault>/.obsidian/plugins/inline-predict/`, reload Obsidian and enable Inline Predict.

Under **Settings → Inline Predict → Model**, set an OpenAI-compatible base URL (such as
`https://api.openai.com/v1`), API key and model ID. Do not append `/chat/completions` to the base URL.
Keyless local servers still need a placeholder key, such as `local`. Use **Test connection** to
send a fixed short request with no note content. Reasoning effort is optional and provider-specific.

## Behavior

- Fill-in-the-middle prompting uses bounded text before and after the cursor.
- Adaptive debounce, context gates and candidate reuse reduce unnecessary calls.
- Reuse checks the original context; changing model/prompt settings clears old work and caches.
- Truncated, repeated or invalid output is repaired or rejected; an optional model judge can check
  suspicious continuations and counts as a separate API call.
- Diagnostics separate completed prediction attempts, actual model calls, known provider usage,
  estimated usage and unknown usage. Stale results are not shown, but their known usage is counted.
- Chinese and Japanese partial word acceptance currently advances one code point at a time.
- IME composition suppresses suggestions; no suggestion means native Tab/Esc behavior.

## Privacy and limits

Configured predictions send cursor-adjacent note context to your selected provider. An optional
relevance check sends a small context/candidate pair to the same provider. API keys are stored in
plain text in the plugin's local `data.json`; consider this when syncing configuration folders.
Statistics stay in memory and reset on reload. There is no telemetry upload or whole-vault scan.
Canceled/discarded requests may still incur provider costs, and unknown usage is labelled explicitly.

Generation is non-streaming. Token estimates are heuristic, not exact tokenizer counts. Mobile,
Windows/Linux and the declared minimum Obsidian version are not fully verified. See
[compatibility notes](docs/en/guide.md#compatibility); `isDesktopOnly: false` is not a tested guarantee.

## Feedback

Include your Obsidian version, platform, editor mode, provider and reproduction steps when reporting
an issue. Do not include API keys or private note content. See the [user guide](docs/en/guide.md).

Licensed under [MIT](LICENSE).
