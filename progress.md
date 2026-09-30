# PromptSecura — Progress

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo scaffold + backend foundation | Code complete; **Codespaces verification pending** |
| 2 | PII detection and sanitization | Code complete; **Codespaces verification pending** |
| 3 | Chrome extension skeleton (MV3, TypeScript, esbuild) | Built and verified in sandbox Chromium; **`npm install` + typecheck with real `@types/chrome` pending** |
| 4 | ChatGPT read-only integration (editor reading, debounced analysis, risk indicator) | Built and verified in sandbox Chromium against a **ChatGPT-like fixture page**; **live chatgpt.com not tested** |
| 5 | Enforcement on ChatGPT (ALLOW / SANITIZE / BLOCK / fail-closed on Send) | Built and verified in sandbox Chromium against a **ChatGPT-like fixture page** (chatgpt.com and chat.openai.com); **live ChatGPT not tested** |
| 6 | Real-site ChatGPT integration (composer fallback, streaming/busy state, SPA navigation, MutationObserver) + committed browser test suite | Built; **75/75 unit + 21/21 e2e tests pass** in the sandbox, against a ChatGPT-like fixture page. **The live chatgpt.com was unreachable (HTTP 403) and has NOT been tested** |

Phase numbering follows the instructions given per phase.

## Decisions log

- **Fail-closed on final Send (MVP).** If the backend is unavailable when the user presses Send, the extension will not submit the prompt. It will show "PromptSecura could not complete the security analysis." and offer edit/retry. It will never label the prompt safe. The backend supports this now: every failure is non-200 with `retryable: true`, and there is no path to ALLOW for an incomplete analysis. The extension-side enforcement is a later phase.
- **Medium score without removable PII → BLOCK.** SANITIZE is only returned when placeholder redaction brings the residual risk to 30 or below.
- **PII contribution capped at 50.** PII alone lands in SANITIZE, never BLOCK.
- **Redaction implemented in-house** (`pipeline/redaction.py`), not with `presidio-anonymizer`.
- **Pipeline core is stdlib + PyYAML only.** FastAPI and Presidio sit at the edges.
- **Phase 2: `sanitized_prompt` is returned whenever PII is found.** Previously it was returned only on SANITIZE. This lets the UI show a redacted draft for BLOCK and ALLOW too. Only SANITIZE means it is safe to send as-is.
- **Phase 2: contextual phone detector** added alongside Presidio. It covers bare numbers like `9876543210`, but only when a phone-related word precedes them.
- **Phase 2: spaCy fallback model** (`en_core_web_sm` by default). It is used only if the configured model is not installed, and `/health` reports which one loaded. Missing models are never auto-downloaded at startup.
- **Phase 2: `IP_ADDRESS` weight raised from 30 to 35**, so an IP address alone is sanitized rather than allowed.
- **Phase 3: backend URL is build-time configuration** (`PROMPTSECURA_BACKEND_URL`). The build also adds that origin to `host_permissions`, so the service worker can call it without CORS. Changing it requires a rebuild.
- **Phase 3: all backend calls go through the service worker**, never the content script, which is subject to the page's CORS/CSP.
- **Phase 3: adapters declare capabilities**, and the content script checks them before relying on any feature.
- **Phase 3: the popup's "Protection status: Active"** is shown as requested. A note underneath describes what the extension actually does; since Phase 4 it reads "ChatGPT prompts are checked as you type (read-only). Sending is not blocked in this version." The backend status shows "Not checked" rather than a state that was never observed.
- **Phase 4: the indicator follows the backend decision**, not just the risk level: ALLOW → Safe, SANITIZE → Medium Risk, BLOCK → High Risk. A medium score escalated to BLOCK therefore shows as High Risk, which matches what enforcement will do.
- **Phase 4: any failure shows "Backend Unavailable" and never "Safe".** One exception: an HTTP 413 shows "Too Long to Analyze", because the backend is up and it is not an outage.
- **Phase 4: strictly read-only** (superseded for Send by Phase 5). Only passive, capture-phase `input` and `paste` listeners are registered. The indicator is a Shadow-DOM host attached to `<html>`, outside ChatGPT's React tree, and positioned with fixed coordinates.
- **Phase 5: one interception path, inside the existing adapter.** `ChatGPTAdapter.onSubmitAttempt` registers `keydown` (Enter without Shift, not during IME composition, in the editor), `click` (send button) and `submit` (composer form) listeners on `window` in the capture phase. They run before ChatGPT's own handlers and cancel the event with `preventDefault()` + `stopImmediatePropagation()`. There is no second system: the adapter hands each attempt to `SubmitGuard`, which uses the existing `AnalysisController` (new `analyzeNow()`) and the existing service-worker/API-client path.
- **Phase 5: the only way to send is `submitApproved(text)`.** It requires the editor to hold exactly `text`, then clicks ChatGPT's own send button (falling back to `form.requestSubmit()`) while a synchronous bypass flag is set. The flag is cleared before the call returns, so it can let through only that one programmatic send.
- **Phase 5: `SubmitGuard` calls `submitApproved` in exactly two cases.** (a) ALLOW for the exact editor text. (b) After "Use Sanitized Prompt": the sanitized text is written, **re-analyzed**, and ALLOWed. Everything else sends nothing: SANITIZE without a choice, BLOCK, any failure, an unreadable editor, text changed during the check, a failed write, or a sanitized text that doesn't come back ALLOW.
- **Phase 5: every Send gets a fresh backend check.** The debounced live result is never reused for the final decision.
- **Phase 5: fail-closed is kept.** Any failure shows the ERROR panel ("PromptSecura could not complete the security analysis.", "Nothing was sent.") with Retry / Edit Prompt. Retry re-checks, and sends only on ALLOW.
- **Phase 5: duplicate protection.** An in-flight lock ignores repeat attempts while a check or panel is open. After a send, identical text within 1.5 s is ignored, because ChatGPT clears its editor asynchronously.
- **Phase 5: writing the sanitized prompt.** For contenteditable (ProseMirror), the editor contents are selected with a Range and replaced with `document.execCommand("insertText")`, so the editor's own state updates. For a textarea, the native value setter is used and an `input` event dispatched. The write is verified by reading back.
- **Phase 5: enforcement panel.** Same Shadow-DOM approach and colours as the indicator. The badges are **SANITIZE** (amber), **BLOCKED** (red), **ERROR** (grey) and **SANITIZED** (green confirmation); SAFE sends with no panel. Findings are shown by entity type and threat category, never by value.
- **Phase 6: no new UI system and no second interception path.** Phase 6 extends the existing `ChatGPTAdapter`, `SubmitGuard` and content-script wiring. All new ChatGPT selectors are in `sites/chatgpt.ts`.
- **Phase 6: composer detection has a fallback.** It tries `EDITOR_SELECTORS` first. If none match, it uses any visible editable element inside a `COMPOSER_FORM_SELECTORS` form (`form[data-type="unified-composer"]`, `form:has(#prompt-textarea)`). Enter and form-submit interception use the same fallback, so renaming the editor's id no longer disables enforcement.
- **Phase 6: "site busy" = ChatGPT's stop button is visible** (`STOP_BUTTON_SELECTORS`, i.e. a reply is streaming). Submit attempts are then ignored without analysis, matching ChatGPT's own behaviour. Previously they ran a check and ended in a "not ready" error.
- **Phase 6: one throttled `MutationObserver` replaces the 1 s poll.** It observes `<body>` (childList, subtree, characterData), coalesced to one check per 150 ms, with a 2 s fallback timer and `popstate` / `hashchange`. PromptSecura's UI hosts are attached to `<html>`, outside `<body>`, so the extension can't trigger its own observer, which rules out a loop.
- **Phase 6: SPA navigation invalidates the guard.** The guard has an epoch counter. `invalidate()` closes any open dialog (new `EnforcementUI.dismiss()`), makes the in-flight attempt stale, and releases the lock immediately. A stale attempt never sends, never opens a dialog, and never releases a newer attempt's lock.
- **Phase 6: listeners are registered once per page** (content-script `INSTANCE_FLAG`) and delegated on `window`/`document`, so composer remounts need no re-registration and can't create duplicate listeners.
- **Phase 6: text extraction strips trailing newlines** left by ProseMirror's empty-paragraph `<br class="ProseMirror-trailingBreak">`.
- **Phase 6: committed browser tests** (`npm run test:e2e`, Playwright). The earlier real-browser checks were sandbox-only scripts; this suite is in the repo and can be re-run by anyone.
- **Phase 4: debounce is 600 ms after typing and 150 ms after a paste**, with a 1 s editor poll. The poll catches changes without input events, such as ChatGPT clearing the editor after Send or a new chat replacing it. Stale responses are discarded with sequence numbers, and unchanged text is never re-sent.

## Implemented

### Phase 1

- Devcontainer (Python 3.11 + Node 20; post-create installs dependencies and the spaCy model)
- FastAPI app, `GET /health`, `POST /api/v1/analyze`
- Pydantic schemas, environment-based configuration, CORS
- Pipeline: preprocess → PII → injection (rules) → scoring → decision → orchestrator
- Injection rules YAML, `requirements.txt`, `pyproject.toml`, tests, README

### Phase 2

- **Presidio PII detection:**
  - Six entity types: `EMAIL_ADDRESS`, `PHONE_NUMBER`, `PERSON`, `CREDIT_CARD`, `IP_ADDRESS`, `URL`.
  - The recognizer name is recorded as each entity's `source`.
  - Explicit spaCy model selection with fallbacks and installed-only checks.
  - Actionable error messages when Presidio or the model is missing.
- **`ContextualPhoneDetector`** (`pipeline/pii_patterns.py`) and **`CompositePIIDetector`** (`pipeline/pii.py`). The composite fails closed if any member fails.
- **Structured results.** Each entity has `entity_type`, `start`, `end`, `score`, `placeholder` and `source`. The response also has `pii_summary` (counts per type). PII values are never returned.
- **Sanitization** with `[EMAIL]`, `[PHONE]`, `[PERSON]`, `[CREDIT_CARD]`, `[IP_ADDRESS]`, `[URL]`. Overlapping detections are merged, keeping the higher score.
- **`pipeline/factory.py`** now does startup assembly, moved out of `main.py`. It returns a `StartupReport`, and `/health` now includes per-component `details`.
- **Logs** add PII *types* (e.g. `pii_types=EMAIL_ADDRESS,PHONE_NUMBER`). Prompts, PII values and sanitized text are still never logged. The original prompt exists only in memory for the duration of the request.
- **New config:** `PROMPTSECURA_SPACY_MODEL_FALLBACKS`, `PROMPTSECURA_PII_CONTEXTUAL_PHONE`.

### Phase 3

- **`extension/` created:**
  - `src/manifest.json` (MV3)
  - Service worker with a message router
  - `api-client.ts`: POST `/api/v1/analyze`, 10 s timeout, runtime validation of the response shape, fail-closed failures that never contain prompt text
  - Content script with double-injection guard and adapter selection
  - `SiteAdapter` interface with a capabilities model
  - ChatGPT placeholder adapter
  - Popup
  - Shared types mirroring the backend schema
  - Build-time config and logger
- **Tooling:**
  - `build.mjs` (esbuild): validates configuration, writes the manifest, and verifies that every file the manifest references exists
  - npm scripts: `build`, `build:prod`, `watch`, `typecheck`, `test`, `check`
  - Strict `tsconfig.json`
  - Unit tests
- **Backend:** unchanged. No compatibility change was needed; the existing CORS regex already allows `chrome-extension://` origins.

### Phase 4

All changes are in `extension/`; the backend is unchanged.

- **`content/sites/chatgpt.ts`: the read-only ChatGPT adapter.**
  - It declares the `readPrompt` and `observeInput` capabilities; `writePrompt` and `interceptSubmit` stay false.
  - `EDITOR_SELECTORS` lists the editor selectors, tried in order, visible elements only: `#prompt-textarea[contenteditable="true"]`, `div.ProseMirror[contenteditable="true"]`, `textarea#prompt-textarea`.
  - It reads text via `innerText` for contenteditable, or `value` for a textarea.
  - It observes typing and paste with passive capture listeners on `document`.
  - The indicator anchors to the editor's `<form>`.
- **`content/sites/adapter.ts`:** the interface gains `observeInput` in the capabilities, plus `findEditor()`, `getIndicatorAnchor()` and `observeInput(listener)`.
- **`content/analysis-controller.ts`:** debounce, the paste fast path, stale-response discarding, the unchanged-text skip, reuse of the last verdict, and failures that are never cached. It is DOM-free and uses injectable timers.
- **`content/indicator-state.ts`:** the states (idle, Analyzing…, Safe, Medium Risk, High Risk, Backend Unavailable / Too Long to Analyze), plus the labels and tooltips.
- **`content/indicator.ts`:** a Shadow-DOM pill with a coloured dot, label and score. The tooltip shows the backend reasons. It follows ChatGPT's light/dark theme and uses fixed positioning above the composer's top-right corner.
- **`content/messaging.ts`:** the content script → service worker bridge. The reply is validated at runtime, and any messaging error (e.g. an extension reload) fails closed.
- **`content/index.ts`:** wires everything together and logs `read-only analysis active`.
- **`shared/config.ts`:** adds `TYPING_DEBOUNCE_MS`, `PASTE_DEBOUNCE_MS` and `EDITOR_POLL_MS`.
- **Popup:** the note now describes read-only mode.
- **Unchanged:** the service worker and API client needed no changes. The existing `promptsecura/analyze` route is now used by the content script.

### Phase 5

All changes are in `extension/`; the backend is unchanged.

- **`content/sites/adapter.ts`:**
  - `SubmitHandler` is now `(source: "enter" | "button" | "form") => void`, called after the adapter has already cancelled the site's submission.
  - Adds `focusEditor()` and `submitApproved(approvedText)`.
  - `setPromptText` now verifies that the write took effect.
- **`content/sites/chatgpt.ts`:**
  - All four capabilities are now true.
  - New `SEND_BUTTON_SELECTORS`: `button[data-testid="send-button"]`, `button#composer-submit-button`, and `button[aria-label="Send prompt"|"Send message"]`.
  - Submit interception, `setPromptText`, `focusEditor`, `submitApproved`, `findSendButton`.
  - All ChatGPT selectors remain in this one file.
- **`content/submit-guard.ts` (new):** the enforcement decision logic. It is DOM-free, with injected editor, UI and clock.
- **`content/enforcement-ui.ts` (new):** the SANITIZE / BLOCKED / ERROR dialogs and the SANITIZED confirmation.
  - The panels use `role="dialog"`, focus the primary button, and close on Esc or ×.
  - All text is set with `textContent`.
- **`content/findings.ts` (new):** entity-type and threat-category descriptions for the panel.
- **`content/analysis-controller.ts`:** new `analyzeNow(text)`, an immediate check that returns the outcome and updates the indicator. `run()` now returns its outcome.
- **`content/index.ts`:** wires `adapter.onSubmitAttempt` → `SubmitGuard` → `controller.analyzeNow` and the `EnforcementPanel`. It logs `protection active`.
- **Popup:** the note now describes enforcement.

### Phase 6

The backend is unchanged.

- **`content/sites/chatgpt.ts`:**
  - New `COMPOSER_FORM_SELECTORS` and `STOP_BUTTON_SELECTORS`.
  - Composer-form fallback in `findEditor()`, Enter interception and form-submit interception.
  - New `isSiteBusy()` and `observeComposer()` (MutationObserver + fallback timer + popstate/hashchange).
  - A shared `firstVisible()` helper.
  - `readEditorText()` strips trailing newlines.
- **`content/sites/adapter.ts`:** new `ComposerChange` type, plus `isSiteBusy()` and `observeComposer()` on `SiteAdapter`.
- **`content/submit-guard.ts`:**
  - `invalidate()` with an epoch counter; stale checks after every await.
  - The `site-busy` and `navigated` results.
  - `EnforcementUI.dismiss()` and the optional `EditorOps.isSiteBusy()`.
- **`content/index.ts`:** the 1 s `setInterval` poll is replaced with `adapter.observeComposer()`; navigation calls `guard.invalidate()`. It logs debug-only metadata (`composer check`, `navigation`).
- **`shared/config.ts`:** `EDITOR_POLL_MS` is replaced by `COMPOSER_CHECK_MS` (150) and `COMPOSER_FALLBACK_CHECK_MS` (2000).
- **`build.mjs`:** new `--outdir=DIR` option, so e2e builds don't overwrite `dist/`.
- **`package.json`:** new `test:e2e` script; `playwright` devDependency (`^1.56.0`).
- **New `e2e/` directory:**
  - `chatgpt.e2e.test.mjs`: 21 tests.
  - `harness.mjs`: build, launch, routing and page helpers.
  - `fixtures/chatgpt.html`: a ChatGPT-like page with the send / voice / stop button states, async clearing, streaming, `pushState`/`popstate` navigation with composer remounts, and click-only and renamed-markup variants.
  - `fixtures/analyze-server.mjs`: the stand-in backend.
- **Unit tests:** 7 new (5 SubmitGuard, 2 adapter), and the navigation-dialog test was hardened.
- **`.gitignore`:** adds `.e2e-dist/`.

## Test status

**Total suite: 110 tests.**

### Backend (Phases 1–2) — passed in the authoring sandbox

83 of 83 tests passed. The sandbox had no network, so real pytest was unavailable. The tests ran through a minimal stdlib harness that provides `pytest.raises` and `tmp_path`.

| Module | Tests | Result |
|---|---|---|
| test_preprocess.py | 7 | passed |
| test_injection.py | 17 | passed |
| test_scoring_and_decision.py | 17 | passed |
| test_redaction_and_pii_wrapper.py | 13 | passed |
| test_pii_detection.py (new in Phase 2) | 15 | passed |
| test_orchestrator.py | 11 | passed |
| test_config.py | 3 | passed |

Correction: Phase 1 reported `test_scoring_and_decision.py` as 18 tests. It had 17. The Phase 1 total of 64 was correct.

The Phase 2 behaviour was also mutation-checked. Four injected bugs were each caught:

1. Contextual phone detector ignoring its context requirement
2. Composite detector swallowing a member failure
3. `sanitized_prompt` restricted to SANITIZE again
4. Startup allowing analysis with no PII detector (fail-open)

All 29 Python files compile, and the internal imports of the FastAPI/Presidio-dependent files resolve.

### Backend — skipped in the sandbox, must run in Codespaces

- **`test_api.py` (13 tests)** needs `fastapi` + `httpx`. It covers HTTP responses, the new `pii_summary`/`source`/`details` fields, sanitized prompts on BLOCK, and a caplog check that no PII appears in logs.
- **`test_pii_presidio.py` (14 tests)** needs `presidio-analyzer` + a spaCy model. It covers real detection of all six entity types, the exact end-to-end sanitization of the workflow example, and the full HTTP stack with real Presidio.

**Presidio itself has still never been executed.** Its wrapper was tested against a fake analyzer.

**Phases 1 and 2 are verified when** `cd backend && python -m pytest` in the Codespace reports **110 passed, 0 skipped**.

### Phase 3 — extension

This sandbox cannot reach the npm registry (HTTP 403), so `npm install` could not run. The checks used the locally installed esbuild 0.27.7 and TypeScript 6.0.3, the versions `package.json` requests, symlinked into the gitignored `node_modules/`. `@types/chrome` is not available locally.

| Check | Result |
|---|---|
| `npm run build` (development) | **Passed.** `dist/` contains the manifest, service worker (ESM), content script (IIFE), popup HTML/JS and source maps. |
| `npm run build:prod` with `PROMPTSECURA_BACKEND_URL=https://my-space-8000.app.github.dev/` | **Passed.** The URL is normalized to an origin, `host_permissions` is set to that origin, and there are no source maps. |
| Invalid `PROMPTSECURA_BACKEND_URL` (with a path) | The build fails with exit code 1 and a clear message, as intended. |
| `npm run typecheck` as shipped | **FAILED in the sandbox:** `TS2688: Cannot find type definition file for 'chrome'`. The cause is that `@types/chrome` can't be installed without registry access. No other errors were reported, but tsc stops at this one, so this is not proof that the rest is clean. |
| `tsc` strict, against a sandbox-only stub of the 5 `chrome.runtime` APIs used (signatures copied from `@types/chrome`) | **Passed, 0 errors**, 12 src/test files checked. An injected error (`sender.idd`) was caught. |
| `npm test` | **20/20 passed:** 11 API client, 4 adapter, 5 build config. |
| Mutation check on the unit tests | **3/3 injected bugs caught:** non-2xx treated as success, response-schema validation disabled, and the ChatGPT placeholder claiming `interceptSubmit`. |
| Real Chromium 141 (Playwright, sandbox-only script) — dev build | **21/21 checks passed.** See below. |
| Real Chromium — production build, Codespaces-style URL | **15/15 checks passed.** The 6 checks that need a localhost fixture server don't apply to a remote URL. |
| Backend | **0 backend files changed** since Phase 2; 83/83 offline backend tests still pass. |

The real-Chromium checks load `extension/dist` as an unpacked extension. They cover:

- **Install:** the MV3 service worker registers, and the manifest has `manifest_version` 3 and the backend `host_permissions`.
- **Popup:** it shows PromptSecura, "Active", "ChatGPT", "Not checked", the configured backend URL and the version, with no script errors (CSP-compliant).
- **Message route:**
  - Unknown messages and unsupported sites are rejected.
  - With no backend running, the result is a fail-closed `network` error carrying the standard message.
- **API client over real HTTP**, against a local **test-fixture server** (not the PromptSecura backend) that sends **no CORS headers**:
  - A valid response passes through unchanged, which confirms `host_permissions` is sufficient.
  - The request is `POST /api/v1/analyze` with `{prompt, site}`.
  - A 503 becomes a retryable `http` failure.
  - A malformed 200 becomes `invalid_response`.
  - No failure payload contains the prompt.
- **Content script:**
  - On a locally served `https://chatgpt.com/` page (routed; no real network), it logs the placeholder status message and leaves the DOM unchanged.
  - It is not injected on another site.

Not covered: the real ChatGPT site (no network), and loading the extension in desktop Google Chrome.

**Still to run with real dependencies:** `cd extension && npm install && npm run check`. This is the first real dependency resolution and the first typecheck against the real `@types/chrome`. Commit the generated `package-lock.json` afterwards.

### Phase 4 — extension

As in Phase 3, there's no npm registry access. The checks used the local esbuild 0.27.7 and TypeScript 6.0.3.

| Check | Result |
|---|---|
| `npm run build` / `npm run build:prod` | **Passed.** |
| `npm run typecheck` as shipped | **Still fails in the sandbox**, only because `@types/chrome` is missing (`TS2688`). This is unchanged from Phase 3. |
| `tsc` strict against the sandbox-only `chrome.runtime` stub | **Passed, 0 errors**, all src/test files checked. |
| `npm test` | **42/42 passed.** That's 20 from Phase 3, with the adapter tests updated for the read-only contract, plus 22 new: 12 controller, 8 indicator-state/messaging, and 2 adapter. |
| Mutation check on the new logic (each mutation in an isolated copy) | **6/6 caught:** stale responses kept, failures cached as verdicts, no debounce, reply not validated, BLOCK shown as medium, adapter claiming `interceptSubmit`. |
| Real Chromium 141, Phase 4 harness | **23/23 passed.** See below. |
| Real Chromium 141, Phase 3 harness (regression) | **21/21 passed.** Its content-script check was updated to the new read-only log message. |
| Backend | **0 files changed**; 83/83 offline backend tests pass. |

The Phase 4 harness is a sandbox-only script. It serves a **fixture page at `https://chatgpt.com/`** that imitates ChatGPT's composer:

- A ProseMirror-style `#prompt-textarea` contenteditable inside a `<form>`, plus a hidden fallback textarea.
- Page-owned Enter and Send handlers that clear the editor programmatically, as ChatGPT does.

A **fixture API server** returns canned ALLOW / SANITIZE / BLOCK / 503 responses. The harness verified:

- **Startup:** the read-only log line appears, and with an empty editor there is no indicator and no request.
- **Typing:** "Analyzing…" shows, then "Safe". Typing 11 characters sends **one** request containing the full text, and the score is shown.
- **Position:** the indicator sits 6 px above the composer, right-aligned.
- **States:**
  - Clearing the editor hides the indicator.
  - An email address shows "Medium Risk" with score 35/100.
  - A paste leads to "High Risk", and the request went out after **161 ms**, under the typing debounce.
- **Send is unchanged:**
  - **Enter still sends a High Risk prompt**, and the Enter keydown was not `defaultPrevented` by the extension.
  - The indicator hides after the page clears the editor without an input event (via the poll).
  - The Send button still sends.
- **Failures:** a 503 shows "Backend Unavailable", with a tooltip saying the prompt has not been checked. A stopped server also shows "Backend Unavailable".
- **Isolation and privacy:**
  - The indicator host is attached to `<html>`, and neither `<body>` nor the form contains any PromptSecura element.
  - Neither the page console nor the indicator ever contains prompt text.
- **Popup:** the note describes read-only mode.

**Not tested:** the live chatgpt.com, desktop Google Chrome, and the real backend over HTTP (FastAPI can't be installed here).

### Phase 5 — extension

There's still no npm registry access; the checks used the local esbuild 0.27.7 and TypeScript 6.0.3.

| Check | Result |
|---|---|
| `npm run build` / `npm run build:prod` | **Passed.** |
| `npm run typecheck` as shipped | **Still fails in the sandbox**, only because `@types/chrome` is missing (`TS2688`). This is unchanged from Phases 3–4. |
| `tsc` strict against the sandbox-only `chrome.runtime` stub | **Passed, 0 errors.** |
| `npm test` | **68/68 passed, 0 cancelled.** That's 42 from Phase 4 (adapter tests updated for the new capabilities), plus 26 new: 19 SubmitGuard, 3 controller `analyzeNow`, 1 findings, and 3 adapter. |
| Mutation check (each mutation in an isolated copy) | **9/9 caught.** SANITIZE sends the original; backend failure fails open; BLOCK submits; no in-flight lock; sanitized text sent without a re-check; stale verdict used after an edit; `analyzeNow` throws instead of failing closed; adapter drops `interceptSubmit`; no post-send duplicate window. |
| Real Chromium 141, Phase 5 harness | **36/36 passed.** See below. |
| Real Chromium, Phase 3 harness (regression) | **21/21 passed**, with the content-script log expectation updated. |
| Real Chromium, Phase 4 harness (regression) | **17/23.** All 6 failures are the intended Phase 5 changes: the read-only log line and popup note; "Enter still sends a High Risk prompt" and "Enter not prevented" (now intentionally reversed); and two follow-on checks that depended on that prompt being sent. All indicator, debounce, paste, position, isolation and privacy checks still pass. |
| Backend | **0 files changed**; 83/83 offline backend tests pass. |

About the test suite itself: the first version of the duplicate-submission unit test caught its mutation only by deadlocking, which cancelled the tests after it. It was rewritten so that a missing lock produces a clean assertion failure, and a realistic delayed-clear scenario was added.

The Phase 5 harness is a sandbox-only script. It serves a **ChatGPT-like fixture page at both `https://chatgpt.com/` and `https://chat.openai.com/`**, with page-owned Enter and form-submit send handlers. A **fixture API server** returns canned decisions: SANITIZE with a real `[EMAIL]`-substituted `sanitized_prompt`, BLOCK for injection text, ALLOW otherwise, plus 503 / stopped-server modes. It adds a 250 ms delay so that repeated clicks overlap a check. The harness verified:

- **SAFE:** a prompt is sent unchanged via Enter, and via the Send button, exactly once, with no panel.
- **No duplicates:** Enter, Enter, click, Enter during one check → **sent exactly once**.
- **MEDIUM:**
  - The original is **not** sent.
  - The panel shows the SANITIZE badge, "Risk 35/100 · Medium", "Email address ×1", and the sanitized prompt, with the buttons Use Sanitized Prompt / Edit Prompt / Cancel.
  - **"Use Sanitized Prompt" sends exactly `Email [EMAIL] the notes`, once**, followed by the SANITIZED confirmation.
  - Edit Prompt, Cancel, × and Esc each send nothing, close the panel, and keep the original text. Edit Prompt also focuses the editor.
- **HIGH:**
  - The panel shows the BLOCKED badge, "Risk 70/100 · High", and "Prompt injection: …", with no send option.
  - The Send button and Enter while blocked, and repeated attempts, **never submit**.
- **Failure:**
  - With a 503, the ERROR panel shows the fail-closed message and "Nothing was sent", and nothing is submitted. Retry, once the backend recovers, sends exactly once.
  - With the server stopped and a PII prompt, Retry and then close sends nothing.
- **Shift+Enter** is not treated as a submit.
- **chat.openai.com:** a SAFE prompt sends once, and a HIGH prompt is blocked.
- **Across the whole run:**
  - **No original PII and no injection text ever reached the page's send handler.** Everything that was sent: `hello world`, `second safe prompt`, `duplicate test`, `Email [EMAIL] the notes`, `safe text during outage`, `hello from chat.openai.com`.
  - The console never contained prompt text.

**Not tested:** the live chatgpt.com / chat.openai.com (unreachable from the sandbox), ChatGPT's real ProseMirror editor and React send handler, desktop Google Chrome, the real FastAPI backend over HTTP, and IME composition.

### Phase 6 — extension

The live chatgpt.com / chat.openai.com were **unreachable (HTTP 403) from the sandbox**. Nothing below was run against the real site. There's still no npm registry access; the checks used the local esbuild 0.27.7, TypeScript 6.0.3 and Playwright 1.56.0 with Chromium 141.

| Check | Result |
|---|---|
| `npm test` (unit) | **75/75 passed, 0 cancelled.** That's 68 from Phase 5 plus 7 new. |
| `npm run test:e2e` (committed browser suite) | **21/21 passed**, and **21/21 on each of 3 further runs** (about 33 s per run). |
| e2e mutation check (isolated copies) | **5/5 caught**, each by its targeted test: composer fallback removed; site-busy check removed; no invalidation on navigation; observer disabled; SANITIZE sends the original. |
| e2e global leak assertion | Verified to fail the run (exit 1) when a raw email is planted in what the page received. |
| Unit mutation check (isolated copies) | **5/5 caught cleanly.** Two needed test fixes first; see below. |
| `tsc` strict against the sandbox `chrome.runtime` stub | **Passed, 0 errors.** It also caught the missing `dismiss()` on the test's `FakeUI` during development. |
| `npm run typecheck` as shipped | **Still fails in the sandbox**, only because `@types/chrome` is missing (`TS2688`). |
| `npm run build` / `build:prod` | **Passed.** |
| Regression: sandbox Phase 5 harness / Phase 3 harness | **36/36 / 21/21 passed.** |
| Backend | **0 files changed**; 83/83 offline tests pass. |

Two weaknesses in the tests were found and fixed:

- **"Stale verdict used after navigation" survived** at first, because `submit()`'s own stale check also covered it (defence in depth). A test now checks the earlier layer directly: after navigation, a stale SANITIZE or BLOCK verdict must not open a dialog on the new page.
- **"Dialog kept open on navigation" was first caught only by a hang**, which cancelled other tests. The test now races the attempt against a 200 ms timeout, so it fails cleanly.

The e2e tests cover:

- **Composer detection:** the standard markup, and the renamed-editor fallback, where Enter is still intercepted.
- **Text extraction:** multi-line text via Shift+Enter; the empty placeholder is never analyzed.
- **Paste:** analyzed in under 500 ms.
- **SAFE:** via Enter, one submit-time analysis and one send; via the Send button, in both the form-submit and click-handler variants, each sent exactly once.
- **SANITIZE:** "Use Sanitized Prompt" sends only `Email [EMAIL] the notes`; Edit Prompt and Cancel send nothing.
- **BLOCK:** Enter, the button, and repeats never submit.
- **Backend failure:** a 503, then Retry, sends once; with the server down, a PII prompt is never sent.
- **Empty prompt:** no analysis, no send, no dialog.
- **Duplicates:** Enter, Enter, click, Enter during a slow check → one send.
- **Prompt edited during a check:** nothing is sent; the next Enter sends the new text once.
- **Streaming:** Enter while the stop button shows is ignored, with no error dialog; sending works afterwards.
- **Navigation:**
  - After 3 new chats (4 composer mounts), one Enter gives one analysis and one send, so there are no duplicate listeners.
  - Navigating while the SANITIZE dialog is open closes it and sends nothing.
  - Navigating to a page without a composer hides the indicator; going Back re-finds the composer, and enforcement works.
- **No observer loop:** an idle page makes no analysis requests and at most 3 checks in 2.5 s.
- **chat.openai.com:** SAFE and BLOCK both behave correctly.
- **Global, after every test:** no raw email and no injection text ever reached the page's send handler, and the console never contained prompt text.

**Not tested:** the live ChatGPT; ChatGPT's real ProseMirror editor (including programmatic insertion of the sanitized text); ChatGPT's real React send handling; desktop Google Chrome; the real FastAPI backend over HTTP; IME composition; the e2e suite in Codespaces.

## Limitations

- **Presidio has not been run.** Detection quality, recognizer names, and the specific test inputs (e.g. the credit-card format with spaces) are unconfirmed until the Codespace run.
- **The contextual phone detector is keyword-based.** It misses numbers with no nearby phone word and can flag e.g. "call ticket 1234567890". Its scope is 10-digit numbers with an optional country code.
- **English only.** PII detection is English and uses English context words.
- **PERSON detection depends on the spaCy model.** The `en_core_web_sm` fallback is noticeably weaker than `en_core_web_lg`.
- **Offsets refer to the normalized prompt**, not the raw input. The extension will need to use the normalized or sanitized text, not splice offsets into the raw DOM text.
- **Placeholders are generic.** Two different emails both become `[EMAIL]`, and the original values cannot be restored.
- **Dependency ranges are not pinned** to verified versions yet. Run `pip freeze` after a green Codespace run.
- **Rule-based injection detection** limitations are unchanged from Phase 1.
- **None of the ChatGPT integration has been verified on the live site.** chatgpt.com returned HTTP 403 from the development sandbox. Every browser test ran against `e2e/fixtures/chatgpt.html`, which models ChatGPT's composer from its publicly known markup and behaviour. If the real site differs (element ids, how Send is triggered, how the editor reacts to programmatic text insertion), the tests won't show it. The live checklist below is the real acceptance test.
- **Enforcement still fails OPEN if ChatGPT's markup changes enough.** Phase 6 narrowed this: renaming the editor's id is now covered by the composer-form fallback. But if **both** `EDITOR_SELECTORS` and `COMPOSER_FORM_SELECTORS` stop matching, Enter isn't intercepted. If `SEND_BUTTON_SELECTORS` also miss, prompts go to ChatGPT **unchecked**. DOM-based interception can't enforce what it can't see. The visible warning sign is the indicator not appearing while typing.
- **If ChatGPT triggers Send from an event other than** Enter keydown, click, or form submit (e.g. `pointerdown`), that path isn't intercepted.
- **Other ways of sending are not intercepted:** editing and resending an earlier message (ChatGPT's inline edit box), voice input, and file/image attachments. Only the main composer's Enter, send button and form submit are covered.
- **Writing the sanitized prompt uses `document.execCommand("insertText")`.** It is deprecated but still supported by Chrome. It worked on the fixture's plain contenteditable, but has **not been tested against ChatGPT's real ProseMirror editor**. If the write doesn't take, nothing is sent and the user is told to edit manually.
- **What was typed stays in ChatGPT's message box** after a BLOCK or SANITIZE, so the user can edit it. The extension prevents it from being *submitted*, but has no control over anything ChatGPT's page itself does with draft text before submission.
- **"Site busy" is detected only by ChatGPT's stop button.** If ChatGPT is busy in a way that shows no stop button, the check runs; if the send button is then missing or disabled, the prompt isn't sent and a "not ready" error appears.
- **The `e2e` suite needs Playwright's Chromium**, via `npx playwright install --with-deps chromium`. It has been run only in the sandbox, not yet in Codespaces.
- **IME composition (e.g. Japanese input):** Enter during composition is left alone. This path was not tested.
- **The ChatGPT selectors have not been tested on the live chatgpt.com**, which is unreachable from the sandbox. They match ChatGPT's known composer markup, and were verified only against a fixture page that imitates it. This is the most likely point of failure. If the indicator never appears, check `EDITOR_SELECTORS` (see README → troubleshooting).
- **The live indicator doesn't auto-retry after "Backend Unavailable"** while the text is unchanged. The next edit, or pressing Send, triggers a new check.
- **The indicator position is heuristic.** It is placed above the right edge of the composer's `<form>`, and may need adjusting against the real layout.
- **No `package-lock.json`** could be generated without registry access. The `@types/chrome` range (`>=0.0.268 <1`) has not been resolved against npm yet.
- **Backend URL changes need a rebuild.** A runtime setting (popup/options) would require `optional_host_permissions`, which is planned for later.
- **Codespaces port visibility now matters.** The extension calls the backend, and a private Codespaces port requires a GitHub login, which the extension can't provide. The indicator then shows "Backend Unavailable". Run the backend locally, or make the port public temporarily with test prompts only; the API has no authentication. See README → *Port visibility and the extension*.
- **No extension icons.** Chrome shows a default icon.

## Next phase

1. **Verify everything with real dependencies first:**
   - `cd backend && python -m pytest` should give 110 passed, 0 skipped.
   - `cd extension && npm install && npm run check`.
   - **On the real chatgpt.com** (desktop Chrome, backend running), confirm that:
     - the indicator appears while typing;
     - a SAFE prompt sends once, via both Enter and the button;
     - an email address triggers SANITIZE, and "Use Sanitized Prompt" sends `[EMAIL]` text;
     - "ignore all previous instructions" is BLOCKED;
     - with the backend stopped, Send shows ERROR and nothing is sent.
     - after **New chat**, all of the above still work, and pressing Enter while a reply is streaming does nothing.
     If any of these fail, fix the `*_SELECTORS` in `sites/chatgpt.ts` or the sanitized write first.
   - `cd extension && npx playwright install --with-deps chromium && npm run test:e2e` should give 21/21.
2. **The next phase is to be defined by you.** The most important next step is running the live checklist on the real chatgpt.com, and fixing selectors or send triggering if anything differs. Candidates after that: warning when the composer can't be found (instead of failing open), a live backend health check in the popup, and extension↔backend authentication before any shared deployment.

## Deliberately deferred

The following are out of scope so far:

- Live backend health check in the popup, and extension↔backend authentication
- Dashboard and database
- Gemini and Claude support
- Chrome Web Store packaging
- ML / semantic injection detection
- Notifications
- Production deployment
