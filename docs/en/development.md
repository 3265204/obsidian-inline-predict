# Development

[中文](../zh-CN/development.md) · [Usage](../../README.en.md)

Inline Predict is a CodeMirror 6 plugin for the Obsidian Markdown editor. Development focuses on
preserving normal editing, using bounded context well and avoiding unnecessary model calls.

## Environment and build

Install Node.js 24, npm and Obsidian 1.13.0 or later locally. Node.js is needed for development tools, not
as a dependency of the plugin runtime.

```bash
git clone https://github.com/3265204/obsidian-inline-predict.git
cd obsidian-inline-predict
npm ci
npm run typecheck
npm run lint -- --max-warnings 0
npm test
npm run build
```

The output is `main.js` in the repository root, in the CommonJS format loaded by Obsidian.
`npm run dev` starts the esbuild watcher; reload the plugin in Obsidian after rebuilding.

## Module responsibilities

| Directory | Responsibility |
| --- | --- |
| `src/core/` | Shared contracts, constants, text helpers and events |
| `src/editor/` | Editor observation, ghost decorations, key handling and partial acceptance |
| `src/completion/` | Integration factory and per-editor completion state machine |
| `src/scheduler/` | Trigger policy, request execution, prediction cache and reuse |
| `src/context/`, `src/tokens/` | Markdown context, structure cache, token estimates and budgets |
| `src/prediction/` | Prompt construction, complete-message budgeting, validation and relevance checks |
| `src/model/` | Model adapter, transport, connection testing and response parsing |
| `src/settings/`, `src/i18n/` | Defaults, normalization, runtime configuration changes and bilingual strings |
| `src/storage/`, `src/telemetry/` | Vault-adapter storage and local statistics |
| `src/plugin/`, `src/ui/` | Runtime composition and settings UI |
| `src/main.ts` | Lifecycle, dependency wiring and command registration |

Shared contracts live in `src/core/types.ts`. Update producers, consumers and relevant tests in the
same change when a contract changes. Keep business logic in its module and `main.ts` focused on wiring.

## Prediction flow

1. The editor observer captures file path, document version, cursor, bounded surrounding text and IME state.
2. A per-editor completion session handles edits, cursor movement and acceptance transactions, reusing unconsumed suggestions where possible.
3. The scheduler checks the master switch, context threshold, debounce and error backoff, then checks its prediction cache.
4. Context and budget modules select nearby text. Prompt budgeting includes system rules, delimiters and the complete messages actually sent.
5. The adapter performs a non-streaming request and parses content, `finish_reason` and provider `usage`. Optional model relevance checks use a separate call.
6. Validation handles truncation and repetition. Request ID, document version, cursor and file path must still match before ghost text is displayed.
7. Only acceptance changes the document. Known model usage is counted independently, including when a stale result is not displayed.

Mid-document completion explicitly asks for `before + insertion + after` to read coherently.
Completion and optional relevance checks both send a single
`<document-around-cursor>before<cursor/>after</document-around-cursor>` excerpt, without
synthetic whitespace or delimiter tags between the text on either side. Only budgeted sections
are rendered; omitted text is never restored from the raw snapshot.
Snapshots capture up to 6,000 preceding and 3,000 following characters before token trimming;
the final request must retain both sides when present, otherwise it is skipped.
Local relevance filtering checks nearby following text before rejecting a candidate based on
the prefix alone. The optional relevance judge shares 300 Unicode code points between the
prefix tail and suffix head, borrowing unused space from either side. Its shared interfaces
live in `src/core/types.ts`. Completed insertions preserve trailing whitespace when following
text exists; whitespace-only output is still rejected. CM6 tests cover ghost-only display,
partial acceptance and full acceptance without changing the original following text.

The system rule asks the model to combine both sides and bridge into the existing suffix,
including when the note resembles a familiar sentence. Following text is
context for the model, not a lexical veto on its output; suffix overlap neither blocks nor
trims the insertion. Regression tests
assert that suffix matches pass through unchanged and do not trigger an extra model check.

The stable system prompt requires `$...$` for inline math and `$$...$$` on its own line for
a standalone formula. It excludes `\(...\)`, `\[...\]` and code fences as math wrappers.
When the cursor is already inside math, the insertion must not duplicate delimiters present
in the prefix or suffix. These rules are included in the complete-message token budget.

## Constraints for changes

- Ghost text is a decoration; never modify Markdown before acceptance. Without a candidate, preserve native Tab/Esc behavior.
- Editor extensions must not throw or interfere with IME. Hide suggestions and pause acceptance during composition.
- Do not use newline or blank-line stop sequences. Inspect `finish_reason`; retain truncated output only at a complete boundary, otherwise reject it.
- Automatic requests default to 2 prefix characters for both named and untitled buffers. Manual prediction bypasses only this threshold, retaining the master switch, IME protection and error backoff.
- Cache and reuse checks must validate original context. Model or prompt configuration changes invalidate candidates, caches and late responses.
- Keep logical attempts, model calls, provider usage, estimates and unknown usage separate. Repeated partial acceptance of one candidate must not inflate candidate acceptance rate.
- Pure logic modules must not import `obsidian`. Inject transport, storage and time through interfaces.
- Runtime code must not use Node filesystem APIs, child processes, Electron or persistent background services. Use the Vault adapter for storage; development tools and build scripts may use Node.
- Keep TypeScript strict, narrow `unknown` and avoid `any`. Add new UI strings to both `src/i18n/en.ts` and `src/i18n/zh-cn.ts`.
- Comments explain reasons; prefer Chinese comments and neutral examples. Justify new runtime dependencies and their bundle impact.
- Keep semantic retrieval and profile learning disabled by default. Design explicit configuration and consent before expanding remote processing.

Internal types and CSS selectors retain `Predictive` / `predictive-*`, and the Vault data root
remains `.predictive/`. The public plugin ID is `inline-predict`; a branding change must not
silently migrate existing data paths.

## Automated checks

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm test
npm run build
node tests/smoke/load-plugin.cjs
```

Typechecking covers source and tests. Vitest tests live in `tests/unit/`; `tests/mocks/obsidian.ts`
replaces the Obsidian runtime, and injected transport/model doubles isolate network calls.

Use fake timers for scheduler state transitions and in-memory adapters for storage. Acceptance
changes should cover consecutive acceptance, undo and remaining suggestions, not only string
splitting helpers. Add regressions for meaningful boundary cases; tests must not call the network.

The smoke script loads the built bundle with a stub Obsidian runtime and checks command,
extension and settings registration plus zero default network calls. It does not establish
real-device, IME or provider compatibility.

## Debugging in a test vault

Create or open a dedicated test vault in Obsidian, then run:

```bash
VAULT="/path/to/test-vault" npm run deploy
```

The script builds and copies `main.js`, `manifest.json` and `styles.css` to the vault's
`.obsidian/plugins/inline-predict/`. Without `VAULT`, it uses `docetest/test` in the repository;
the target must already contain `.obsidian/`. Enable the plugin and reload after copying.

Exercise continuous typing, cursor movement, file switching, Tab/Esc, repeated partial acceptance,
undo, Chinese/Japanese IME, timeout backoff and live model settings changes. Record actual
platforms, Obsidian versions and editor modes tested.

For UI testing without a paid model service, run in another terminal:

```bash
npm run mock:server
```

Use `http://127.0.0.1:8765/v1`, placeholder key `local-mock` and model ID `mock-model` in the test
vault. This server returns canned text and checks request/rendering flow rather than generation
quality. Its `.tmp/mock-requests.log` includes prompt snippets.

## Data and commit scope

Obsidian stores settings and API keys in the plugin's `data.json`; keys are plain text. Diagnostics
stay in memory. `.predictive/` is the Vault-adapter data root; a hidden folder is not encryption.

Public documentation consists of the root bilingual READMEs, docs indexes and bilingual
development documents. Keep reviews, internal architecture drafts, goals/progress records,
collaboration configuration, test vaults, request logs and credentials out of commits. Inspect
`.gitignore` and staged files; do not force-add excluded local data.

## Release files

Keep versions in `package.json`, the lockfile and `manifest.json` aligned, and maintain the
release-to-minimum-app-version mapping in `versions.json`. Minimum-version and mobile claims
must be supported by actual testing.

Generated `main.js` is not committed as source. The GitHub Release tag must exactly match the
manifest version, for example `0.1.1` without a `v` prefix. Attach `main.js`, `manifest.json` and
`styles.css` separately. An additional installation ZIP may contain these files under
`inline-predict/`, but does not replace the separate assets.

The maintainer handles publication; documentation edits or source synchronization do not
automatically create a Release. Keep usage instructions in the root README, with no separate guide.


## Settings search and build provenance

The tab uses Obsidian 1.13.0 `getSettingDefinitions()` to index category names and their translated
setting labels while preserving the collapsible layout. Do not call a provider or read credentials
when creating search metadata. Refresh through `update()`, not the deprecated `display()`.

`npm run lint` runs the official Obsidian ESLint recommended rules against runtime source. Tests
and Node development tools are covered by typechecking and their relevant checks. The lint tools
are development dependencies and are not bundled into the plugin.

The maintainer can manually run **Build and attest plugin assets** in GitHub Actions. It checks,
builds and attests the three installable files, then uploads them as `inline-predict-assets`.
It does not create or modify a GitHub Release. Download and extract the workflow artifact, then
upload its `main.js`, `manifest.json` and `styles.css` to the Release without changing their bytes.

Adding this workflow does not retroactively attest existing Releases. An attestation applies
only to the actual files built and signed by that run. Example verification:
`gh attestation verify main.js --repo 3265204/obsidian-inline-predict`.
