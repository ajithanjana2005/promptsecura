# PromptSecura — Progress

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo scaffold + backend foundation | Code complete; **Codespaces verification pending** |
| 2 | PII detection and sanitization | Code complete; **Codespaces verification pending** |
| 3 | Chrome extension skeleton (MV3, TypeScript, esbuild) | Built and verified in sandbox Chromium; **`npm install` + typecheck with real `@types/chrome` pending** |
| 4 | ChatGPT read-only integration (editor reading, debounced analysis, risk indicator) | Built and verified in sandbox Chromium against a **ChatGPT-like fixture page**; **live chatgpt.com not tested** |
| 5 | Enforcement (recommended below) | Not started |

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
- **Phase 4: strictly read-only.** Only passive, capture-phase `input` and `paste` listeners are registered. There are no keydown, click or submit listeners, `preventDefault` is never called, and nothing is written into ChatGPT's DOM. The indicator is a Shadow-DOM host attached to `<html>`, outside ChatGPT's React tree, and positioned with fixed coordinates.
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

## Limitations

- **Presidio has not been run.** Detection quality, recognizer names, and the specific test inputs (e.g. the credit-card format with spaces) are unconfirmed until the Codespace run.
- **The contextual phone detector is keyword-based.** It misses numbers with no nearby phone word and can flag e.g. "call ticket 1234567890". Its scope is 10-digit numbers with an optional country code.
- **English only.** PII detection is English and uses English context words.
- **PERSON detection depends on the spaCy model.** The `en_core_web_sm` fallback is noticeably weaker than `en_core_web_lg`.
- **Offsets refer to the normalized prompt**, not the raw input. The extension will need to use the normalized or sanitized text, not splice offsets into the raw DOM text.
- **Placeholders are generic.** Two different emails both become `[EMAIL]`, and the original values cannot be restored.
- **Dependency ranges are not pinned** to verified versions yet. Run `pip freeze` after a green Codespace run.
- **Rule-based injection detection** limitations are unchanged from Phase 1.
- **The extension warns but does not protect yet.** It is read-only: High Risk prompts can still be sent. Enforcement is the next phase.
- **The ChatGPT selectors have not been tested on the live chatgpt.com**, which is unreachable from the sandbox. They match ChatGPT's known composer markup, and were verified only against a fixture page that imitates it. This is the most likely point of failure. If the indicator never appears, check `EDITOR_SELECTORS` (see README → troubleshooting).
- **After "Backend Unavailable", there is no automatic retry** while the text is unchanged. The next edit triggers a new check.
- **The indicator position is heuristic.** It is placed above the right edge of the composer's `<form>`, and may need adjusting against the real layout.
- **No `package-lock.json`** could be generated without registry access. The `@types/chrome` range (`>=0.0.268 <1`) has not been resolved against npm yet.
- **Backend URL changes need a rebuild.** A runtime setting (popup/options) would require `optional_host_permissions`, which is planned for later.
- **Codespaces port visibility now matters.** The extension calls the backend, and a private Codespaces port requires a GitHub login, which the extension can't provide. The indicator then shows "Backend Unavailable". Run the backend locally, or make the port public temporarily with test prompts only; the API has no authentication. See README → *Port visibility and the extension*.
- **No extension icons.** Chrome shows a default icon.

## Next phase

1. **Verify everything with real dependencies first:**
   - `cd backend && python -m pytest` should give 110 passed, 0 skipped.
   - `cd extension && npm install && npm run check`.
   - **New in Phase 4:** load `extension/dist` in desktop Chrome, run the backend, and type on the real chatgpt.com. Confirm that the indicator appears and changes state. If it doesn't, fix `EDITOR_SELECTORS` first; everything later depends on it.
2. **Recommended Phase 5: enforcement on ChatGPT.**
   - Implement `interceptSubmit`: capture Enter and the send button, re-analyze the final text on Send, and apply ALLOW / SANITIZE / BLOCK.
   - Implement `writePrompt` for "Use Sanitized Prompt", plus "Edit" on BLOCK.
   - Apply the agreed **fail-closed** Send policy: "PromptSecura could not complete the security analysis." with edit/retry.

## Deliberately deferred

The following are out of scope so far:

- Send interception and enforcement (BLOCK/SANITIZE on Send), writing the sanitized prompt, and fail-closed Send handling (backend and API client already support it)
- Live backend health check in the popup, and extension↔backend authentication
- Dashboard and database
- Gemini and Claude support
- Chrome Web Store packaging
- ML / semantic injection detection
- Notifications
- Production deployment
