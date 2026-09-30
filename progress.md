# PromptSecura — Progress

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo scaffold + backend foundation | Code complete; **Codespaces verification pending** |
| 2 | PII detection and sanitization | Code complete; **Codespaces verification pending** |
| 3 | To be defined | Not started |

Phase numbering follows the instructions given per phase. The Chrome extension, ChatGPT integration, enforcement UI, popup and extension↔backend auth from the original plan are all still to come.

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

## Test status

**Total suite: 110 tests.**

### Passed in the authoring sandbox

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

### Skipped in the sandbox — must run in Codespaces

- **`test_api.py` (13 tests)** needs `fastapi` + `httpx`. It covers HTTP responses, the new `pii_summary`/`source`/`details` fields, sanitized prompts on BLOCK, and a caplog check that no PII appears in logs.
- **`test_pii_presidio.py` (14 tests)** needs `presidio-analyzer` + a spaCy model. It covers real detection of all six entity types, the exact end-to-end sanitization of the workflow example, and the full HTTP stack with real Presidio.

**Presidio itself has still never been executed.** Its wrapper was tested against a fake analyzer.

**Phases 1 and 2 are verified when** `cd backend && python -m pytest` in the Codespace reports **110 passed, 0 skipped**.

## Limitations

- **Presidio has not been run.** Detection quality, recognizer names, and the specific test inputs (e.g. the credit-card format with spaces) are unconfirmed until the Codespace run.
- **The contextual phone detector is keyword-based.** It misses numbers with no nearby phone word and can flag e.g. "call ticket 1234567890". Its scope is 10-digit numbers with an optional country code.
- **English only.** PII detection is English and uses English context words.
- **PERSON detection depends on the spaCy model.** The `en_core_web_sm` fallback is noticeably weaker than `en_core_web_lg`.
- **Offsets refer to the normalized prompt**, not the raw input. The extension will need to use the normalized or sanitized text, not splice offsets into the raw DOM text.
- **Placeholders are generic.** Two different emails both become `[EMAIL]`, and the original values cannot be restored.
- **Dependency ranges are not pinned** to verified versions yet. Run `pip freeze` after a green Codespace run.
- **Rule-based injection detection** limitations are unchanged from Phase 1.

## Next phase

1. **First, verify Phases 1–2 in Codespaces.** Create the Codespace, then run `cd backend && python -m pytest`. Fix any failures before new work.
2. **Phase 3 scope is to be defined by you.** The original plan's next step was the Chrome extension skeleton (MV3 + TypeScript) with read-only ChatGPT analysis and the risk indicator.

## Deliberately deferred

The following are out of scope so far:

- Chrome extension and ChatGPT integration
- Enforcement UI and fail-closed Send handling
- Popup, and extension↔backend authentication
- Dashboard and database
- Gemini and Claude support
- ML / semantic injection detection
- Notifications
- Production deployment
