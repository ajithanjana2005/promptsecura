"""Pipeline orchestrator: preprocess -> PII -> injection -> score -> decide.

Fail-closed: if any detector raises, ``AnalysisIncompleteError`` is raised
and no decision is produced. There is no code path that returns ALLOW for a
prompt that was not fully analyzed.

Privacy: log records contain only metadata (request id, lengths, counts,
rule ids, decision, score, latency). Prompt text, sanitized text and PII
values are never logged.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import Counter

from app.pipeline.base import (
    AnalysisIncompleteError,
    AnalysisResult,
    Decision,
    InjectionDetector,
    PIIDetector,
)
from app.pipeline.decision import Thresholds, decide
from app.pipeline.preprocess import preprocess
from app.pipeline.redaction import redact, resolve_overlaps
from app.pipeline.scoring import ScoringConfig, score_signals

logger = logging.getLogger("promptsecura.pipeline")


class AnalysisOrchestrator:
    def __init__(
        self,
        pii_detector: PIIDetector,
        injection_detector: InjectionDetector,
        scoring_config: ScoringConfig,
        thresholds: Thresholds,
    ) -> None:
        self._pii = pii_detector
        self._injection = injection_detector
        self._scoring = scoring_config
        self._thresholds = thresholds

    @property
    def detectors(self) -> dict[str, str]:
        return {"pii": self._pii.name, "injection": self._injection.name}

    def analyze(self, prompt: str, site: str) -> AnalysisResult:
        started = time.perf_counter()
        request_id = uuid.uuid4().hex

        pre = preprocess(prompt)

        try:
            raw_pii = self._pii.detect(pre.text)
        except Exception as exc:  # noqa: BLE001 - any failure means fail closed
            logger.error(
                "analysis_incomplete request_id=%s stage=pii error=%s",
                request_id,
                type(exc).__name__,
            )
            raise AnalysisIncompleteError("pii") from exc

        try:
            injection_matches = self._injection.detect(pre.text)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "analysis_incomplete request_id=%s stage=injection error=%s",
                request_id,
                type(exc).__name__,
            )
            raise AnalysisIncompleteError("injection") from exc

        pii_entities = resolve_overlaps(raw_pii)
        breakdown = score_signals(
            pii_entities, injection_matches, pre.hidden_chars_removed, self._scoring
        )
        decision = decide(breakdown, bool(pii_entities), self._thresholds)

        sanitized = redact(pre.text, pii_entities) if decision.decision is Decision.SANITIZE else None

        reasons: list[str] = []
        for entity_type, count in sorted(Counter(e.entity_type for e in pii_entities).items()):
            reasons.append(f"Sensitive information detected: {entity_type} x{count}")
        for match in injection_matches:
            reasons.append(f"{match.description} (rule: {match.rule_id})")
        if pre.hidden_chars_removed:
            reasons.append(
                f"Removed {pre.hidden_chars_removed} hidden/zero-width character(s) "
                "(possible obfuscation)"
            )
        reasons.extend(decision.reasons)

        latency_ms = round((time.perf_counter() - started) * 1000, 2)

        logger.info(
            "analysis_complete request_id=%s site=%s prompt_chars=%d decision=%s "
            "risk_score=%d pii_count=%d injection_rules=%s hidden_chars=%d latency_ms=%.2f",
            request_id,
            site,
            pre.original_length,
            decision.decision.value,
            breakdown.total,
            len(pii_entities),
            ",".join(m.rule_id for m in injection_matches) or "-",
            pre.hidden_chars_removed,
            latency_ms,
        )

        return AnalysisResult(
            request_id=request_id,
            decision=decision.decision,
            risk_level=decision.risk_level,
            risk_score=breakdown.total,
            reasons=tuple(reasons),
            pii_entities=tuple(pii_entities),
            injection_matches=tuple(injection_matches),
            score_breakdown=breakdown,
            sanitized_prompt=sanitized,
            latency_ms=latency_ms,
            detectors=self.detectors,
        )
