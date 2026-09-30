# PromptSecura — Progress

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 1 | Repo scaffold + backend pipeline | Code complete; Codespaces verification pending (see below) |
| 2 | Chrome extension skeleton, ChatGPT read-only analysis + indicator | Not started |
| 3 | Enforcement: intercept send, ALLOW/SANITIZE/BLOCK UI, fail-closed | Not started |
| 4 | Popup & settings | Not started |
| 5 | Hardening: extension↔backend token, more rules/tests | Not started |

## Decisions log

- **2026-09-30 — Fail-closed on final Send (MVP).** If the backend is unavailable when the user presses Send, the extension will not submit the prompt. It will show "PromptSecura could not complete the security analysis." and offer edit/retry. It will never label the prompt safe. The backend supports this now: every failure returns non-200 with `retryable: true`, and no code path returns ALLOW for an incomplete analysis. The extension-side enforcement is Phase 3.
- **Medium score without removable PII → BLOCK.** SANITIZE is only returned when placeholder redaction brings the residual risk to 30 or below.
- **PII contribution capped at 50.** PII alone lands in SANITIZE, not BLOCK, because it can be redacted.
- **Redaction implemented in-house** (`pipeline/redaction.py`) instead of with `presidio-anonymizer`. This deviates from the initial plan. The reasons: deterministic overlap handling, one dependency fewer, and it can be unit-tested without Presidio.
- **Pipeline core is stdlib + PyYAML only.** FastAPI and Presidio sit at the edges, and Presidio is imported lazily.

## Phase 1 deliverables

- [x] `.devcontainer/` (Python 3.11 + Node 20, post-create installs deps and spaCy model)
- [x] FastAPI app factory with lifespan detector loading (`app/main.py`)
- [x] `GET /health` with per-component status
- [x] `POST /api/v1/analyze` with full pipeline
- [x] Pydantic v2 schemas (`app/schemas/analysis.py`)
- [x] Env-driven configuration (`app/config.py`, `.env.example`)
- [x] CORS (chrome-extension origin regex by default, configurable)
- [x] Pipeline interfaces + Phase-1 implementations: preprocess, PII (Presidio), injection (rules), scoring, decision, orchestrator
- [x] Injection rules file (`app/rules/injection_rules.yaml`, 6 rules)
- [x] `requirements.txt`, `pyproject.toml`
- [x] pytest suite
- [x] README, progress.md

## Test status

### Verified in the authoring sandbox (no network, so no pip installs)

64 of 64 tests passed across 6 modules. Real pytest was not installable there, so the tests ran through a minimal stdlib harness that supplied `pytest.raises` and `tmp_path`.

| Module | Tests | Result |
|---|---|---|
| test_preprocess.py | 7 | passed |
| test_injection.py | 17 | passed |
| test_scoring_and_decision.py | 18 | passed |
| test_redaction_and_pii_wrapper.py | 11 | passed |
| test_orchestrator.py | 9 | passed |
| test_config.py | 3 | passed |

The suite was also mutation-checked. Three deliberately injected bugs were each caught:

1. PII-stage failure silently ignored instead of failing closed
2. Raw prompt written to logs
3. Medium risk without PII returned SANITIZE instead of BLOCK

Also checked in the sandbox:

- All 26 Python files compile.
- `pyproject.toml` parses.
- `devcontainer.json` is valid JSON.
- `post-create.sh` passes `bash -n`.

### NOT yet verified — run in Codespaces

- **`tests/test_api.py` (11 tests)** needs `fastapi` + `httpx`, which were not installable. It covers the HTTP endpoints, 422/413/503 responses, CORS, and not echoing PII.
- **`tests/test_pii_presidio.py` (6 tests)** needs `presidio-analyzer` + the spaCy model, which were not installable. It covers real Presidio detection and the end-to-end SANITIZE/BLOCK examples from the workflow image.
- **The whole suite under real pytest.**
- **The devcontainer build and `post-create.sh`.** Codespaces is not available in the sandbox.
- **Starting uvicorn and calling the API with curl.**
- **Dependency version ranges.** They have not been resolved against PyPI yet. Once everything works, pin them with `pip freeze`.

**Phase 1 is complete once** `python -m pytest` in the Codespace shows all tests passing with 0 skipped, and the curl examples in the README return sensible results.

## Known limitations / open items

- **Bare 10-digit phone numbers** like `9876543210` may not be detected by Presidio's default phone recognizer, depending on its region settings. This is untested. `test_detects_bare_ten_digit_phone_from_workflow_example` will show the answer. If it fails, add a custom recognizer.
- **Rule-based injection detection** misses paraphrased attacks and can flag benign text. For example, "ignore the previous instructions in the recipe" matches `instruction_override`.
- **`en_core_web_lg` is large.** If Codespace setup is too slow, set `PROMPTSECURA_SPACY_MODEL=en_core_web_sm`, which is faster but less accurate PERSON detection.
- **PII offsets** refer to the *normalized* prompt, not the raw input.
- **Intent extraction** (from the workflow image's pre-processing box) is not implemented.
- **English only.**

## Deliberately deferred

The following are out of scope for Phase 1:

- Chrome extension and ChatGPT integration (Phases 2–3)
- Popup (Phase 4) and extension↔backend authentication (Phase 5)
- Dashboard, analytics and database
- Gemini and Claude support
- ML / semantic injection detection
- Notifications
- Production deployment
- `docs/` folder
