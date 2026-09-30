# PromptSecura — Progress

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo scaffold + backend foundation | Code complete; **Codespaces verification pending** |
| 2 | PII detection and sanitization | Code complete; **Codespaces verification pending** |
| 3 | Chrome extension skeleton (MV3, TypeScript, esbuild) | Built and verified in sandbox Chromium; **`npm install` + typecheck with real `@types/chrome` pending** |
| 4 | To be defined (recommended below) | Not started |

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
- **Phase 3: adapters declare capabilities.** The ChatGPT placeholder declares none, and the content script checks capabilities before doing anything.
- **Phase 3: the popup's "Protection status: Active"** is shown as requested, together with a line saying prompt checks on ChatGPT are not enabled in this build yet. The backend status shows "Not checked" rather than a state that was never observed.

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

## Limitations

- **Presidio has not been run.** Detection quality, recognizer names, and the specific test inputs (e.g. the credit-card format with spaces) are unconfirmed until the Codespace run.
- **The contextual phone detector is keyword-based.** It misses numbers with no nearby phone word and can flag e.g. "call ticket 1234567890". Its scope is 10-digit numbers with an optional country code.
- **English only.** PII detection is English and uses English context words.
- **PERSON detection depends on the spaCy model.** The `en_core_web_sm` fallback is noticeably weaker than `en_core_web_lg`.
- **Offsets refer to the normalized prompt**, not the raw input. The extension will need to use the normalized or sanitized text, not splice offsets into the raw DOM text.
- **Placeholders are generic.** Two different emails both become `[EMAIL]`, and the original values cannot be restored.
- **Dependency ranges are not pinned** to verified versions yet. Run `pip freeze` after a green Codespace run.
- **Rule-based injection detection** limitations are unchanged from Phase 1.
- **The extension does not protect anything yet.** The ChatGPT adapter is a placeholder; no prompts are read, analyzed or blocked.
- **No `package-lock.json`** could be generated without registry access. The `@types/chrome` range (`>=0.0.268 <1`) has not been resolved against npm yet.
- **Backend URL changes need a rebuild.** A runtime setting (popup/options) would require `optional_host_permissions`, which is planned for later.
- **Codespaces port visibility.** For the extension to reach a Codespaces backend, port 8000 must be **public**, because private ports require a GitHub login. The API has no authentication yet, so keep it private until an auth phase. This does not matter in Phase 3, since nothing calls the backend yet.
- **No extension icons.** Chrome shows a default icon.

## Next phase

1. **Verify everything with real dependencies first:**
   - `cd backend && python -m pytest` should give 110 passed, 0 skipped.
   - `cd extension && npm install && npm run check`.
2. **Recommended Phase 4: ChatGPT adapter plus read-only analysis and indicator.**
   - Implement the ChatGPT adapter's `readPrompt` capability: locate the prompt editor and read its text.
   - On typing (debounced) and on send, send the text to the service worker's `promptsecura/analyze` route.
   - Show the on-page indicator (analyzing / safe / sanitize / block / "could not complete").
   - **Do not block sending yet.** This validates the DOM integration and the real network path with low risk.
3. **Then enforcement:**
   - Intercept Enter and the send button (`interceptSubmit`) and apply ALLOW/SANITIZE/BLOCK, with fail-closed behaviour on Send.
   - Write the sanitized prompt back into the editor (`writePrompt`).

## Deliberately deferred

The following are out of scope so far:

- ChatGPT DOM integration and prompt interception
- Enforcement UI and fail-closed Send handling (backend and API client already support it)
- Live backend health check in the popup, and extension↔backend authentication
- Dashboard and database
- Gemini and Claude support
- Chrome Web Store packaging
- ML / semantic injection detection
- Notifications
- Production deployment
