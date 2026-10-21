# Inline Predict — inline AI completion for Obsidian

[中文](README.md)

Inline Predict previews continuations as grey text inside the Markdown editor. Press **Tab** to accept,
**Esc** to dismiss, or use commands to accept a word/character, sentence or line. Suggestions do not
modify the note until accepted.

**Version 0.1.2 — beta. Requires Obsidian 1.13.0 or later.**

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

## Usage

| Action | Effect |
| --- | --- |
| Pause typing | Automatically predicts when the context threshold is met |
| Tab | Accepts the full suggestion; retains native behavior without one |
| Esc | Dismisses the suggestion; retains native behavior without one |
| Predict now command | Requests a prediction manually; a hotkey can be assigned |
| Accept next word / sentence / line commands | Inserts that part and keeps the remainder visible |
| Toggle inline prediction command | Turns completion on or off |

### Automatic prediction, partial acceptance and IME

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

Assign command hotkeys in Obsidian's hotkey settings. Latin text advances by word; Han and Kana
advance by character. Sentence acceptance recognizes punctuation such as `。！？` without Japanese
word segmentation. Line acceptance includes its trailing newline. Touch controls are available,
but mobile keyboard and touch behavior have not been verified on real devices.

## Output checks

Output is checked for completion status, repetition, control markers and truncation. Text cut off
by the output token limit is used only when a complete boundary can be retained; otherwise it is hidden.
Local relevance filtering covers specific short Han-character contexts with longer suggestions;
it does not fully cover pure Kana, English or longer contexts. The optional model relevance check
uses a separate YES/NO request for suspicious suggestions and adds a model call and waiting time.
Both filtering switches take effect immediately.

No suggestion can be a valid outcome: the model may have no continuation, filtering may reject it,
or the context may not fit the budget. Check generated facts and wording yourself.

## Usage statistics

| Metric | Meaning |
| --- | --- |
| Prediction attempts | Completed logical attempts, including failed, canceled and stale attempts |
| Model calls | Actual adapter calls, counting completion and relevance checks separately |
| Failed model calls | Provider failures; deliberate cancellation is not counted as provider failure |
| Input / output tokens | Provider-reported usage or explicitly labelled local estimates |
| Unknown usage | Calls with no usable usage result, such as timeouts or cancellation |
| Cache / prefix reuse | Uses of existing suggestions, not new model calls |
| Acceptance rate | Accepted candidates divided by displayed candidates; repeated partial acceptance counts once |
| Partial acceptance share | Partial-accept operations divided by all accept operations |
| Latency | Recent completed, non-failed prediction durations, excluding the wait before requesting |

Counters reset on plugin reload. Stale results are not displayed, but their known usage is retained.
Cancellation does not guarantee that a provider stops processing or billing. Unknown usage is not
zero cost; a potentially understated total cost is withheld when usage is unknown. The settings UI
currently has no price configuration.

## Privacy and costs

Configured predictions send cursor-adjacent note context to your selected provider. An optional
relevance check sends a small context/candidate pair to the same provider. API keys are stored in
plain text in the plugin's local `data.json`; consider this when syncing configuration folders.
Statistics stay in memory and reset on reload. There is no telemetry upload or whole-vault scan.
Canceled/discarded requests may still incur provider costs, and unknown usage is labelled explicitly.

## Known limitations

Generation is non-streaming. Token estimates are heuristic, not exact tokenizer counts.
Multi-line ghost wrapping may differ from inserted text. Windows, Linux, iOS, Android and the
declared minimum Obsidian version are not fully device-verified. `isDesktopOnly: false` reflects
the code's mobile constraints, not a tested compatibility guarantee. There is no path exclusion
list; disable prediction for notes you do not want sent to a model provider.

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

**Old suggestions after changing the model:** changing settings clears caches and invalidates
old requests. If this still occurs, report your steps, version and local diagnostics without keys.

**Testing Japanese:** try mixed Kanji/Kana and pure Kana using the same model and trigger method.
Check naturalness, script consistency and character/sentence acceptance. There is no measured claim
of superiority over other plugins for Japanese writing.

## Feedback

Include your Obsidian version, platform, editor mode, provider and reproduction steps when reporting
an issue. Do not include API keys or private note content.

Licensed under [MIT](LICENSE).
