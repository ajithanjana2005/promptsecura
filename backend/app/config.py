"""Runtime configuration for the PromptSecura backend.

Every setting has a safe default and can be overridden with an environment
variable prefixed ``PROMPTSECURA_`` (see ``.env.example`` in the repo root).
Invalid values raise ``ValueError`` at startup rather than being ignored.

Stdlib-only on purpose, so configuration can be tested without FastAPI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from app import __version__
from app.pipeline.decision import Thresholds
from app.pipeline.scoring import ScoringConfig

ENV_PREFIX = "PROMPTSECURA_"
PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_RULES_PATH = PACKAGE_DIR / "rules" / "injection_rules.yaml"
DEFAULT_PII_ENTITIES: tuple[str, ...] = (
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON",
    "CREDIT_CARD",
    "IP_ADDRESS",
    "URL",
)
# Chrome extension origins are chrome-extension://<32 chars a-p>.
DEFAULT_CORS_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"
_LOG_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}


def _raw(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(ENV_PREFIX + name)
    if value is None or value.strip() == "":
        return None
    return value.strip()


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = _raw(env, name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{ENV_PREFIX}{name} must be an integer, got {raw!r}") from exc


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = _raw(env, name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{ENV_PREFIX}{name} must be a number, got {raw!r}") from exc


def _csv(env: Mapping[str, str], name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _raw(env, name)
    if raw is None:
        return default
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    app_name: str = "PromptSecura"
    version: str = __version__
    log_level: str = "INFO"
    spacy_model: str = "en_core_web_lg"
    pii_entities: tuple[str, ...] = DEFAULT_PII_ENTITIES
    pii_score_threshold: float = 0.4
    injection_rules_path: Path = DEFAULT_RULES_PATH
    max_prompt_chars: int = 20_000
    cors_origins: tuple[str, ...] = ()
    cors_origin_regex: str | None = DEFAULT_CORS_ORIGIN_REGEX
    thresholds: Thresholds = field(default_factory=Thresholds)
    scoring: ScoringConfig = field(default_factory=ScoringConfig)

    def __post_init__(self) -> None:
        if self.log_level not in _LOG_LEVELS:
            raise ValueError(f"log_level must be one of {sorted(_LOG_LEVELS)}")
        if not 0.0 <= self.pii_score_threshold <= 1.0:
            raise ValueError("pii_score_threshold must be between 0 and 1")
        if self.max_prompt_chars <= 0:
            raise ValueError("max_prompt_chars must be positive")
        if not self.pii_entities:
            raise ValueError("pii_entities must not be empty")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env

        regex_raw = env.get(ENV_PREFIX + "CORS_ORIGIN_REGEX")
        if regex_raw is None:
            cors_origin_regex: str | None = DEFAULT_CORS_ORIGIN_REGEX
        else:
            cors_origin_regex = regex_raw.strip() or None  # empty string disables it

        rules_raw = _raw(env, "INJECTION_RULES_PATH")

        return cls(
            log_level=(_raw(env, "LOG_LEVEL") or "INFO").upper(),
            spacy_model=_raw(env, "SPACY_MODEL") or "en_core_web_lg",
            pii_entities=_csv(env, "PII_ENTITIES", DEFAULT_PII_ENTITIES),
            pii_score_threshold=_float(env, "PII_SCORE_THRESHOLD", 0.4),
            injection_rules_path=Path(rules_raw) if rules_raw else DEFAULT_RULES_PATH,
            max_prompt_chars=_int(env, "MAX_PROMPT_CHARS", 20_000),
            cors_origins=_csv(env, "CORS_ORIGINS", ()),
            cors_origin_regex=cors_origin_regex,
            thresholds=Thresholds(
                allow_max=_int(env, "ALLOW_MAX", 30),
                sanitize_max=_int(env, "SANITIZE_MAX", 60),
            ),
        )
