"""Shared types and interfaces for the PromptSecura analysis pipeline.

This module is deliberately stdlib-only so that the pipeline can be imported
and unit-tested without FastAPI, Pydantic or Presidio installed. Web-facing
schemas live in ``app.schemas``; concrete detectors implement the Protocols
defined here, which is what lets a future ML detector replace or sit
alongside the Phase-1 rule-based one without touching the API.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable


class Decision(str, Enum):
    ALLOW = "ALLOW"
    SANITIZE = "SANITIZE"
    BLOCK = "BLOCK"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(frozen=True)
class PreprocessResult:
    """Output of the pre-processing stage.

    ``text`` is the normalized text that every later stage analyzes. PII
    offsets and the sanitized prompt refer to this normalized text.
    """

    text: str
    original_length: int
    hidden_chars_removed: int
    control_chars_removed: int


@dataclass(frozen=True)
class PIIEntity:
    """A span of detected PII. Offsets refer to the normalized text.

    The matched text itself is intentionally not stored, so results can be
    logged or returned without echoing sensitive values.
    """

    entity_type: str
    start: int
    end: int
    score: float


@dataclass(frozen=True)
class InjectionMatch:
    rule_id: str
    category: str
    description: str
    weight: int


@dataclass(frozen=True)
class ScoreBreakdown:
    pii: int
    injection: int
    obfuscation: int
    total: int

    @property
    def residual_after_sanitization(self) -> int:
        """Risk that would remain if all PII were replaced with placeholders."""
        return self.injection + self.obfuscation


@dataclass(frozen=True)
class DecisionResult:
    decision: Decision
    risk_level: RiskLevel
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class AnalysisResult:
    request_id: str
    decision: Decision
    risk_level: RiskLevel
    risk_score: int
    reasons: tuple[str, ...]
    pii_entities: tuple[PIIEntity, ...]
    injection_matches: tuple[InjectionMatch, ...]
    score_breakdown: ScoreBreakdown
    sanitized_prompt: str | None
    latency_ms: float
    detectors: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class PIIDetector(Protocol):
    name: str

    def detect(self, text: str) -> list[PIIEntity]:
        """Return PII entities found in ``text``. Raise ``DetectorError`` on failure."""
        ...


@runtime_checkable
class InjectionDetector(Protocol):
    name: str

    def detect(self, text: str) -> list[InjectionMatch]:
        """Return injection signals found in ``text``. Raise ``DetectorError`` on failure."""
        ...


class DetectorError(Exception):
    """A detector could not load or could not analyze input.

    Messages must never include the prompt text.
    """


class AnalysisIncompleteError(Exception):
    """A required pipeline stage failed, so no security decision can be made.

    Callers must treat this as fail-closed: no ALLOW decision is produced.
    """

    def __init__(self, stage: str) -> None:
        super().__init__(f"Analysis stage '{stage}' failed")
        self.stage = stage
