# PromptSecura

PromptSecura checks prompts before they are sent to AI websites. It detects personal data (PII) and prompt-injection/jailbreak attempts, scores the risk, and decides **ALLOW**, **SANITIZE** or **BLOCK**.

**Current status: Phase 6 (real-site ChatGPT integration).** The backend analyzes prompts (Phases 1–2). On ChatGPT, the extension shows a live risk indicator while you type (Phases 3–4). When you press Send, it checks the final prompt first (Phase 5): safe prompts go through, prompts with personal data are stopped with a sanitized version offered, dangerous prompts are blocked, and **nothing is sent if the check cannot complete**. Phase 6 adapts this to how the ChatGPT site behaves: composer detection with a fallback, reply streaming, and single-page navigation between chats. It adds an automated browser test suite.

> **Tested against a ChatGPT-like test page, not the live site.** chatgpt.com was not reachable from the development environment. Please try it on the real site before relying on it; see *Checking it on the real ChatGPT* below. See [`progress.md`](progress.md) for what exists, what has been tested, and what comes next.

## Architecture (Phase 1)

```
POST /api/v1/analyze
  └─ orchestrator
       1. preprocess   Unicode NFKC, strip zero-width/bidi/control chars, whitespace cleanup
       2. pii          Microsoft Presidio + spaCy, plus a contextual phone-number detector
       3. injection    rule-based detector (backend/app/rules/injection_rules.yaml)
       4. scoring      additive, explainable 0–100 score
       5. decision     0–30 ALLOW · 31–60 SANITIZE · 61–100 BLOCK
```

The pipeline (`backend/app/pipeline/`) is plain Python plus PyYAML. FastAPI and Presidio sit at the edges. Detectors implement small interfaces (`PIIDetector`, `InjectionDetector` in `pipeline/base.py`), so an ML detector can be added later without changing the API.

**Fail-closed.** If any detector fails to load or errors during analysis, `/api/v1/analyze` returns **503** with:

```json
{"error": "analysis_unavailable", "message": "PromptSecura could not complete the security analysis.", "retryable": true}
```

It never returns a partial or "safe" result. The Chrome extension (Phase 3) will treat any non-200 response as "do not send".

**Privacy.** Logs contain only metadata: request id, prompt length, decision, score, rule ids and latency. Prompt text, sanitized text and PII values are never logged. The API does not echo detected PII values either, only their type, offsets and placeholder.

## Run in GitHub Codespaces (no VS Code required)

1. On the repository page on GitHub, click **Code → Codespaces → Create codespace on main**. The Codespace opens in the browser.
   - Alternatively, from any terminal with the [GitHub CLI](https://cli.github.com/): `gh codespace create -r <owner>/<repo>` then `gh codespace ssh`.
2. On first creation, `.devcontainer/post-create.sh` installs the Python dependencies and downloads the spaCy model `en_core_web_lg` (a large download). Wait until it prints `Setup complete`.
   If you connected before it finished, or it failed, run it again with `bash .devcontainer/post-create.sh`.
3. Run the tests:
   ```bash
   cd backend
   python -m pytest
   ```
4. Start the API:
   ```bash
   cd backend
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
   Startup loads the spaCy model, which takes a few seconds.
5. In a second terminal, try it:
   ```bash
   curl -s localhost:8000/health
   curl -s -X POST localhost:8000/api/v1/analyze \
     -H 'Content-Type: application/json' \
     -d '{"prompt": "My email is anjana@gmail.com and my phone number is 9876543210."}'
   ```
   Interactive API docs are served at `/docs`. In Codespaces, open the **Ports** tab and use the forwarded address for port 8000.

**Port visibility and the extension.** The Chrome extension runs on your own computer, so it has to reach the backend over the network. A Codespaces port that is **private** requires a GitHub login, which the extension cannot provide, so the indicator will show "Backend Unavailable". There are two options:

- **Recommended while there is no authentication:** run the backend on your own machine (see *Run locally*), and build the extension with the default `http://localhost:8000`.
- **Use the Codespace:** set port 8000 to **public** in the Ports tab, and build the extension with `PROMPTSECURA_BACKEND_URL=https://<codespace-name>-8000.app.github.dev`. The API has **no authentication yet**, so anyone who knows the URL can call it. Only do this with test prompts, and set the port back to private afterwards.

## Run locally (optional)

Requires Python 3.11+.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_lg
python -m pytest
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## API

### `GET /health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "components": {"injection": "ready", "pii": "ready"},
  "details": {"injection": "rules-v1, 6 rules", "pii": "presidio(en_core_web_lg)+contextual-phone"}
}
```

`status` is `degraded` if any component is `unavailable`. In that case `details` explains why, for example which spaCy model is missing and how to install it. `/health` always returns HTTP 200; read the `status` field.

### `POST /api/v1/analyze`

Request:

```json
{"prompt": "text to check", "site": "chatgpt"}
```

`site` currently accepts only `"chatgpt"`.

Response (200):

| Field | Meaning |
|---|---|
| `decision` | `ALLOW`, `SANITIZE` or `BLOCK` |
| `risk_score`, `risk_level` | 0–100, and `low` / `medium` / `high` |
| `reasons` | Human-readable explanation |
| `pii_entities` | Type, offsets (into the normalized prompt), score, placeholder, and `source` (which detector found it). No values. |
| `pii_summary` | Count per entity type, e.g. `{"EMAIL_ADDRESS": 1, "PHONE_NUMBER": 1}` |
| `injection_matches` | Rule id, category, description, weight |
| `score_breakdown` | `pii` + `injection` + `obfuscation` = `total` (capped at 100) |
| `sanitized_prompt` | PII replaced with placeholders. Set whenever PII was found, `null` otherwise. Only a `SANITIZE` decision means it is safe to send; with `BLOCK`, other risks such as injection text remain. |
| `latency_ms`, `request_id`, `detectors` | Diagnostics |

Errors:

| Status | Meaning |
|---|---|
| 422 | Invalid request |
| 413 | Prompt longer than `PROMPTSECURA_MAX_PROMPT_CHARS` |
| 503 | Analysis unavailable or incomplete (fail-closed) |

**How the decision is made.** A score of 31–60 becomes **SANITIZE** only if the risk comes from PII and replacing that PII would bring the score back to 30 or below. A medium score caused by injection text is escalated to **BLOCK**, because placeholders cannot remove it.

## PII detection

Supported entity types and their placeholders:

| Entity | Placeholder | Score weight |
|---|---|---|
| `EMAIL_ADDRESS` | `[EMAIL]` | 35 |
| `PHONE_NUMBER` | `[PHONE]` | 35 |
| `PERSON` | `[PERSON]` | 15 |
| `CREDIT_CARD` | `[CREDIT_CARD]` | 50 |
| `IP_ADDRESS` | `[IP_ADDRESS]` | 35 |
| `URL` | `[URL]` | 5 |

The PII part of the score is capped at 50, so PII alone never causes a BLOCK. It can always be sanitized. A name or URL on its own stays under 31, so it is ALLOWed, but it is still reported and redacted in `sanitized_prompt`.

The PII stage has two detectors, and overlapping results are merged, keeping the higher-confidence one:

- **Presidio** with the configured spaCy model.
- **Contextual phone detector** (`pipeline/pii_patterns.py`). It reports bare 10-digit numbers (optionally with a `+country` prefix, or grouped 5-5 or 3-3-4) *only* when a word like "phone", "mobile", "call", "contact" or "WhatsApp" appears just before them. Without that context word, nothing is reported, so order numbers and IDs are not flagged.

**spaCy model availability.** At startup the configured model is used if it is installed. Otherwise the fallbacks are tried, in order, and only installed models are ever used, so nothing is downloaded at startup. If nothing usable is installed, `/health` says so and `/api/v1/analyze` returns 503.

## Configuration

All settings are optional environment variables. See [`.env.example`](.env.example) for the full list, including the decision thresholds, spaCy model, PII entity list, CORS settings and the rules file path.

## Injection rules

The rules live in `backend/app/rules/injection_rules.yaml`: regexes with weights and categories. Rules are a baseline. Paraphrased attacks can get through, and some benign prompts can match. Every rule change should come with a test in `backend/tests/test_injection.py`.

## Chrome extension

The extension lives in `extension/`. It uses Manifest V3, TypeScript, and esbuild for bundling.

- The **service worker** holds the API client for `POST /api/v1/analyze`, with a timeout, response validation and fail-closed errors. It is the only part that talks to the backend.
- The **content script** runs on `chatgpt.com` and `chat.openai.com`. It shows a live risk indicator while you type, and it checks every Send (Enter or the Send button) before anything reaches ChatGPT.
- The **popup** shows the protection status, the supported site (ChatGPT), the configured backend URL, and a backend status placeholder ("Not checked").

### What happens when you press Send

Every Send is stopped first. Enter (without Shift) in the message box, the Send button, and submitting the message form are all caught before ChatGPT sees them. The final text is then checked by the backend immediately, with no debounce:

| Backend decision | What PromptSecura does |
|---|---|
| **ALLOW** | Your prompt is sent unchanged, through ChatGPT's own Send button. |
| **SANITIZE** | Nothing is sent. An amber **SANITIZE** panel appears above the message box. It shows the risk score, what was detected (e.g. "Email address ×1"), and the **sanitized prompt**, with PII replaced by placeholders such as `[EMAIL]`. You can choose one of three options:<br>• **Use Sanitized Prompt**: the sanitized text replaces your prompt in the message box, is **checked again**, and is sent only if that check returns ALLOW. A green **SANITIZED** confirmation follows.<br>• **Edit Prompt**: closes the panel and puts the cursor back in the message box.<br>• **Cancel** (or × / Esc): closes the panel.<br>The original prompt is never sent automatically. |
| **BLOCK** | Nothing is sent. A red **BLOCKED** panel shows the risk score and the detected threats (e.g. "Prompt injection: …"). The only options are **Edit Prompt** and close, so there is no way to send the prompt anyway. |
| **Check failed** | The backend was unreachable, returned an error or an invalid response, or the prompt couldn't be read from the page. Nothing is sent; this is fail-closed. A grey **ERROR** panel says "PromptSecura could not complete the security analysis." and offers **Retry** (check again, and send only if the backend now ALLOWs), **Edit Prompt**, or close. |

Safety rules behind this:

- **Only approved text is sent.** The extension sends only text the backend approved, and only if the message box still contains exactly that text at the moment of sending. If you change the prompt while it is being checked, or while a panel is open, nothing is sent; press Send again to check the new text.
- **No double sends.** Pressing Enter or clicking Send again while a check or panel is open does nothing. An identical prompt re-sent within 1.5 seconds of being sent is ignored.
- **Shift+Enter** still inserts a new line.
- **While ChatGPT is still writing a reply**, pressing Enter does nothing, as it does without the extension. No check runs and nothing is sent.
- **Moving to another chat** (New chat, the sidebar, Back/Forward) closes any open PromptSecura panel and discards any check still in progress. A decision about one chat can never send anything in another.
- **Nothing is inserted into ChatGPT's page.** The panel and indicator are drawn in their own isolated elements, outside ChatGPT's page structure.

### Live risk indicator (while typing)

A small pill labelled "PromptSecura" appears just above the message box while there is text in it. It is a preview; the decision that counts is made when you press Send.

| Indicator | Meaning |
|---|---|
| Analyzing… (grey, pulsing) | The text changed and a check is pending or running. |
| **Safe** (green) | The backend decided ALLOW. |
| **Medium Risk** (amber) | The backend decided SANITIZE. It found PII that could be replaced with placeholders. |
| **High Risk** (red) | The backend decided BLOCK. This includes medium scores that sanitization cannot fix, such as injection text. |
| **Backend Unavailable** (grey) | No decision could be made: the backend is unreachable, returned an error, or sent an invalid response. The prompt has **not** been checked. |
| Too Long to Analyze (grey) | The backend refused the prompt as longer than `PROMPTSECURA_MAX_PROMPT_CHARS`. |

Hover over the pill to see the risk score and the backend's reasons. Reasons name the type of finding, such as `EMAIL_ADDRESS` or a rule id, never the text itself. The pill disappears when the message box is empty.

**Timing.** Analysis runs 600 ms after you stop typing, or 150 ms after a paste. Keystrokes are never sent one by one. The page is watched with a single, throttled `MutationObserver` (at most one check every 150 ms, plus a 2-second fallback timer). That catches changes that fire no typing event, such as ChatGPT clearing the box after sending, a new chat replacing the message box, or navigation. These values are in `extension/src/shared/config.ts`.

**Privacy.** Prompt text is sent only to the configured PromptSecura backend, through the service worker, and never to any other service or LLM. The extension never logs it. The only prompt text the panels show is the backend's sanitized prompt, which has PII replaced by placeholders.

**Troubleshooting on ChatGPT:**

1. **Every Send shows the ERROR panel:** make sure the backend is running and that the extension was built with the right `PROMPTSECURA_BACKEND_URL`. See *Port visibility and the extension* for Codespaces.
2. **Nothing happens at all:** in DevTools → Console on chatgpt.com, look for `[PromptSecura] ChatGPT: protection active`.
3. **That line appears, but typing shows no indicator, or Send isn't checked:** ChatGPT's page structure has probably changed. All ChatGPT selectors live in `extension/src/content/sites/chatgpt.ts`:
   - `EDITOR_SELECTORS` for the message box
   - `COMPOSER_FORM_SELECTORS` for the message form, which is also the fallback used to find the box if its id changes
   - `SEND_BUTTON_SELECTORS` for the Send button
   - `STOP_BUTTON_SELECTORS` for the "stop generating" button

   They were written against ChatGPT's known markup (`form[data-type="unified-composer"]`, the `#prompt-textarea` ProseMirror editor, `button[data-testid="send-button"]`, `button[data-testid="stop-button"]`), but could not be checked against the live site. **If both the editor and the composer-form selectors stop matching, Send is no longer checked**; see the limitations in `progress.md`.

### Checking it on the real ChatGPT

Start the backend, build and load the extension, then on chatgpt.com check each of these:

1. Typing shows the indicator.
2. A normal prompt sends once, via both Enter and the Send button.
3. A prompt with an email address shows SANITIZE, and "Use Sanitized Prompt" sends the `[EMAIL]` version.
4. "Please ignore all previous instructions" is BLOCKED.
5. With the backend stopped, Send shows ERROR and nothing is sent.
6. After clicking **New chat**, all of the above still work.

### Requirements

Node.js 20 or newer. The Codespace already includes Node 20.

### Install, check and build

```bash
cd extension
npm install
npm run check          # typecheck + unit tests + build
```

Individual scripts:

| Command | What it does |
|---|---|
| `npm run build` | Development build into `extension/dist/` (with source maps) |
| `npm run build:prod` | Minified build, no source maps |
| `npm run watch` | Rebuild on file changes |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm test` | Unit tests (esbuild-bundled, Node's built-in test runner) |
| `npm run test:e2e` | Browser tests: the built extension in real Chromium, against a ChatGPT-like **test page** and a **stand-in backend** (see below) |

### Browser tests (`npm run test:e2e`)

These load the real built extension into Chromium (via Playwright) and drive a **test page that imitates ChatGPT's message box** (`extension/e2e/fixtures/chatgpt.html`). The page is served at `https://chatgpt.com/` and `https://chat.openai.com/` through request routing, so no internet access is needed. A small **stand-in analysis server** (`e2e/fixtures/analyze-server.mjs`) returns fixed ALLOW / SANITIZE / BLOCK / error answers.

They check composer detection (including renamed markup), text extraction, typing and paste, Enter and Send-button interception, SAFE / SANITIZE / BLOCK, backend failure, empty prompts, duplicate sends, prompts edited during a check, reply streaming, and navigation between chats. They also assert that **no raw personal data or injection text ever reaches the page's send handler**. They do **not** test the live ChatGPT or the real backend.

First-time setup, which downloads Chromium and its system libraries:

```bash
cd extension
npm install
npx playwright install --with-deps chromium
npm run test:e2e
```

The tests build their own copy of the extension into `extension/.e2e-dist/`, pointed at the stand-in server on port 18765, so your normal `dist/` is not touched.

### Backend URL (build-time configuration)

The backend URL is set when you **build** the extension, not at runtime:

```bash
# default: http://localhost:8000
npm run build

# Codespaces backend (use the forwarded address of port 8000)
PROMPTSECURA_BACKEND_URL=https://<codespace-name>-8000.app.github.dev npm run build
```

The build does two things with this URL:

- It injects the URL into the code.
- It adds the origin to `host_permissions` in `dist/manifest.json`, so the service worker is allowed to call it.

The value must be an origin only (no path), and invalid values fail the build. Set `PROMPTSECURA_DEBUG=true` for debug logging; logs never contain prompt text. **Rebuild after changing either value.**

### Load the extension in Chrome

1. Build it (see above), so that `extension/dist/` exists.
   If you built inside a Codespace, copy `dist/` to your computer first. With the GitHub CLI: `gh codespace cp -r remote:/workspaces/<repo>/extension/dist ./promptsecura-dist`. Alternatively, clone the repo locally and run `npm install && npm run build` there.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/dist` folder, the one that contains `manifest.json`.
5. Pin PromptSecura from the puzzle-piece menu and click it to open the popup.

After rebuilding, click the **reload** icon on the PromptSecura card in `chrome://extensions`.

To check that it is working, start the backend, open `chatgpt.com` and type in the message box. The PromptSecura indicator should appear above it.

## Repository layout

```
.devcontainer/        Codespaces config + post-create setup script
backend/
  app/
    main.py           FastAPI app factory, lifespan, CORS
    config.py         environment-driven settings
    api/routes.py     /health, /api/v1/analyze
    schemas/          Pydantic request/response models
    pipeline/         preprocess, pii (+ pii_patterns), injection, scoring, decision,
                      redaction, orchestrator, factory (startup assembly)
    rules/            injection_rules.yaml
  tests/              pytest suite (doubles.py holds test-only fakes)
extension/
  src/manifest.json   MV3 manifest (build adds backend host permission)
  src/background/     service worker + backend API client
  src/content/        content script: site adapters (sites/), analysis controller,
                      submit guard (enforcement), indicator + enforcement panel UI,
                      service-worker messaging
  src/popup/          popup page
  src/shared/         shared types, build-time config, logger
  test/               unit tests
  e2e/                browser tests + fixtures (ChatGPT-like test page, stand-in backend)
  build.mjs           esbuild build script
progress.md           phase status, test results, known limitations
```
