# PromptSecura

PromptSecura checks prompts before they are sent to AI websites. It detects personal data (PII) and prompt-injection/jailbreak attempts, scores the risk, and decides **ALLOW**, **SANITIZE** or **BLOCK**.

**Current status: Phase 3.** The backend analyzes prompts (Phases 1–2). The Chrome extension skeleton is in place (Phase 3), but it **does not check ChatGPT prompts yet**: prompt interception comes in a later phase. See [`progress.md`](progress.md) for what exists, what has been tested, and what comes next.

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

**Port visibility.** Leave port 8000 **private** in Phase 1. The API has no authentication yet. It only needs to be reachable from the browser extension starting in Phase 2, and a shared token is planned before the port is ever made public.

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

## Chrome extension (Phase 3 skeleton)

The extension lives in `extension/`. It uses Manifest V3, TypeScript, and esbuild for bundling. In this phase:

- The **service worker** holds the API client for `POST /api/v1/analyze`, with a timeout, response validation and fail-closed errors. It exposes an internal message route, but nothing sends prompts to it yet.
- The **content script** loads on `chatgpt.com` / `chat.openai.com` and selects the site adapter. The **ChatGPT adapter is a placeholder**: it does not read the prompt, change the page, or intercept sending. The content script logs that prompts are not being checked.
- The **popup** shows the protection status, the supported site (ChatGPT), the configured backend URL, and a backend status placeholder ("Not checked").

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

To see the content script's status message, open `chatgpt.com` and look at DevTools → Console. You should see: `[PromptSecura] ChatGPT: prompt interception is not implemented in this build; prompts on this site are not being checked.`

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
  src/content/        content script + site adapters (sites/adapter.ts, sites/chatgpt.ts)
  src/popup/          popup page
  src/shared/         shared types, build-time config, logger
  test/               unit tests
  build.mjs           esbuild build script
progress.md           phase status, test results, known limitations
```
