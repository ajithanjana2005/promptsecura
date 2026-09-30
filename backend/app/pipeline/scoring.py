"""Risk scoring stage (Phase 1: transparent additive scoring).

score = min(100, pii + injection + obfuscation)

* pii: for each entity type, its weight plus ``pii_repeat_weight`` for every
  additional occurrence; summed, then capped at ``pii_cap``. The cap keeps PII
  on its own inside the SANITIZE band, because PII can be removed with
  placeholders.
* injection: sum of matched rule weights, capped at ``injection_cap``.
* obfuscation: a fixed weight if hidden/zero-width characters were removed
  during pre-processing.

Every number here is configurable and reported back in the API response, so
the score is explainable rather than a black box.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from app.pipeline.base import InjectionMatch, PIIEntity, ScoreBreakdown

DEFAULT_PII_WEIGHTS: dict[str, int] = {
    "CREDIT_CARD": 50,
    "EMAIL_ADDRESS": 35,
    "PHONE_NUMBER": 35,
    "IP_ADDRESS": 35,
    "PERSON": 15,
    "URL": 5,
}


@dataclass(frozen=True)
class ScoringConfig:
    pii_weights: Mapping[str, int] = field(default_factory=lambda: dict(DEFAULT_PII_WEIGHTS))
    pii_default_weight: int = 20
    pii_repeat_weight: int = 5
    pii_cap: int = 50
    injection_cap: int = 100
    obfuscation_weight: int = 10
    max_score: int = 100

    def __post_init__(self) -> None:
        values = [
            self.pii_default_weight,
            self.pii_repeat_weight,
            self.pii_cap,
            self.injection_cap,
            self.obfuscation_weight,
            *self.pii_weights.values(),
        ]
        if any(v < 0 for v in values):
            raise ValueError("Scoring weights and caps must be non-negative")
        if self.max_score != 100:
            raise ValueError("max_score must be 100 (risk scores are 0-100)")


def score_signals(
    pii_entities: Sequence[PIIEntity],
    injection_matches: Sequence[InjectionMatch],
    hidden_chars_removed: int,
    config: ScoringConfig,
) -> ScoreBreakdown:
    counts = Counter(entity.entity_type for entity in pii_entities)
    pii = sum(
        config.pii_weights.get(entity_type, config.pii_default_weight)
        + config.pii_repeat_weight * (count - 1)
        for entity_type, count in counts.items()
    )
    pii = min(pii, config.pii_cap)

    injection = min(sum(m.weight for m in injection_matches), config.injection_cap)
    obfuscation = config.obfuscation_weight if hidden_chars_removed > 0 else 0

    total = min(pii + injection + obfuscation, config.max_score)
    return ScoreBreakdown(pii=pii, injection=injection, obfuscation=obfuscation, total=total)
