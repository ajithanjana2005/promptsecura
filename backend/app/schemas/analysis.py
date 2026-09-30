"""Pydantic v2 request/response schemas for the HTTP API.

These are the API contract the Chrome extension will consume in Phase 2.
Detected PII values are never echoed back: entities are returned as type,
offsets (into the normalized prompt), score and placeholder only.
"""

from __future__ import annotations

from collections import Counter
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.pipeline.base import AnalysisResult
from app.pipeline.redaction import placeholder_for

SupportedSite = Literal["chatgpt"]  # Gemini/Claude are added in a later phase.


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1, description="The prompt text to analyze.")
    site: SupportedSite = Field(default="chatgpt", description="Site the prompt is for.")


class PIIEntityOut(BaseModel):
    entity_type: str
    start: int = Field(description="Start offset in the normalized prompt.")
    end: int = Field(description="End offset (exclusive) in the normalized prompt.")
    score: float
    placeholder: str
    source: str = Field(description="Detector that found it, e.g. 'presidio:EmailRecognizer'.")


class InjectionMatchOut(BaseModel):
    rule_id: str
    category: str
    description: str
    weight: int


class ScoreBreakdownOut(BaseModel):
    pii: int
    injection: int
    obfuscation: int
    total: int


class AnalyzeResponse(BaseModel):
    request_id: str
    decision: Literal["ALLOW", "SANITIZE", "BLOCK"]
    risk_level: Literal["low", "medium", "high"]
    risk_score: int = Field(ge=0, le=100)
    reasons: list[str]
    pii_entities: list[PIIEntityOut]
    pii_summary: dict[str, int] = Field(description="Count of detected entities per type.")
    injection_matches: list[InjectionMatchOut]
    score_breakdown: ScoreBreakdownOut
    sanitized_prompt: str | None = Field(
        description=(
            "Normalized prompt with every detected PII entity replaced by a placeholder. "
            "Set whenever PII was found, otherwise null. Only a SANITIZE decision means it "
            "is safe to send; with BLOCK, other risks (e.g. injection text) remain in it."
        )
    )
    latency_ms: float
    detectors: dict[str, str]

    @classmethod
    def from_result(cls, result: AnalysisResult) -> "AnalyzeResponse":
        b = result.score_breakdown
        return cls(
            request_id=result.request_id,
            decision=result.decision.value,
            risk_level=result.risk_level.value,
            risk_score=result.risk_score,
            reasons=list(result.reasons),
            pii_entities=[
                PIIEntityOut(
                    entity_type=e.entity_type,
                    start=e.start,
                    end=e.end,
                    score=round(e.score, 4),
                    placeholder=placeholder_for(e.entity_type),
                    source=e.source,
                )
                for e in result.pii_entities
            ],
            pii_summary=dict(sorted(Counter(e.entity_type for e in result.pii_entities).items())),
            injection_matches=[
                InjectionMatchOut(
                    rule_id=m.rule_id,
                    category=m.category,
                    description=m.description,
                    weight=m.weight,
                )
                for m in result.injection_matches
            ],
            score_breakdown=ScoreBreakdownOut(
                pii=b.pii, injection=b.injection, obfuscation=b.obfuscation, total=b.total
            ),
            sanitized_prompt=result.sanitized_prompt,
            latency_ms=result.latency_ms,
            detectors=dict(result.detectors),
        )


class ErrorResponse(BaseModel):
    error: str
    message: str
    retryable: bool


ComponentState = Literal["ready", "unavailable", "not_loaded"]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    components: dict[str, ComponentState]
    details: dict[str, str] = Field(
        default_factory=dict,
        description="Per-component detail, e.g. which spaCy model loaded or why it is unavailable.",
    )
