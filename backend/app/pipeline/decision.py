"""Decision stage.

Default bands (from the PromptSecura workflow design):
    0-30   ALLOW
    31-60  SANITIZE
    61-100 BLOCK

SANITIZE only makes sense when replacing PII with placeholders actually
brings the risk back into the ALLOW band. If a medium score comes from
signals sanitization cannot remove (e.g. injection text), the prompt is
escalated to BLOCK so the user edits it, rather than being offered a
"sanitized" prompt that still carries the risk.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.pipeline.base import Decision, DecisionResult, RiskLevel, ScoreBreakdown


@dataclass(frozen=True)
class Thresholds:
    allow_max: int = 30
    sanitize_max: int = 60

    def __post_init__(self) -> None:
        if not 0 <= self.allow_max < self.sanitize_max <= 100:
            raise ValueError(
                "Thresholds must satisfy 0 <= allow_max < sanitize_max <= 100 "
                f"(got allow_max={self.allow_max}, sanitize_max={self.sanitize_max})"
            )


def risk_level_for(score: int, thresholds: Thresholds) -> RiskLevel:
    if score <= thresholds.allow_max:
        return RiskLevel.LOW
    if score <= thresholds.sanitize_max:
        return RiskLevel.MEDIUM
    return RiskLevel.HIGH


def decide(
    breakdown: ScoreBreakdown,
    has_redactable_pii: bool,
    thresholds: Thresholds,
) -> DecisionResult:
    score = breakdown.total
    level = risk_level_for(score, thresholds)

    if level is RiskLevel.LOW:
        return DecisionResult(Decision.ALLOW, level, ("Risk score is in the low-risk range.",))

    if level is RiskLevel.HIGH:
        return DecisionResult(Decision.BLOCK, level, ("Risk score is in the high-risk range.",))

    if has_redactable_pii and breakdown.residual_after_sanitization <= thresholds.allow_max:
        return DecisionResult(
            Decision.SANITIZE,
            level,
            ("Sensitive information can be replaced with placeholders before sending.",),
        )

    return DecisionResult(
        Decision.BLOCK,
        level,
        ("Medium risk comes from signals that placeholder sanitization cannot remove.",),
    )
