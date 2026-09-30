"""Builds the analysis pipeline from settings and reports component status.

Kept free of FastAPI so that startup behaviour (including what happens when
Presidio or a spaCy model is missing) can be tested on its own.

Fail-closed: if any required component cannot be built, no orchestrator is
returned and the API refuses to analyze.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.pipeline.base import DetectorError, PIIDetector
from app.pipeline.injection import RuleBasedInjectionDetector
from app.pipeline.orchestrator import AnalysisOrchestrator
from app.pipeline.pii import CompositePIIDetector, PresidioPIIDetector
from app.pipeline.pii_patterns import ContextualPhoneDetector

if TYPE_CHECKING:
    from app.config import Settings

logger = logging.getLogger("promptsecura.startup")

READY = "ready"
UNAVAILABLE = "unavailable"


@dataclass
class StartupReport:
    orchestrator: AnalysisOrchestrator | None
    components: dict[str, str] = field(default_factory=dict)
    details: dict[str, str] = field(default_factory=dict)


def build_pii_detector(settings: "Settings") -> PIIDetector:
    presidio = PresidioPIIDetector.create(
        spacy_model=settings.spacy_model,
        entities=settings.pii_entities,
        score_threshold=settings.pii_score_threshold,
        fallback_models=settings.spacy_model_fallbacks,
    )
    if settings.pii_contextual_phone and "PHONE_NUMBER" in settings.pii_entities:
        return CompositePIIDetector([presidio, ContextualPhoneDetector()])
    return presidio


def build_orchestrator(settings: "Settings") -> StartupReport:
    report = StartupReport(orchestrator=None)

    injection = None
    try:
        injection = RuleBasedInjectionDetector.from_file(settings.injection_rules_path)
        report.components["injection"] = READY
        report.details["injection"] = f"{injection.name}, {len(injection.rules)} rules"
    except DetectorError as exc:
        logger.error("Injection detector unavailable: %s", exc)
        report.components["injection"] = UNAVAILABLE
        report.details["injection"] = str(exc)

    pii = None
    try:
        pii = build_pii_detector(settings)
        report.components["pii"] = READY
        report.details["pii"] = pii.name
        model = _presidio_model(pii)
        if model and model != settings.spacy_model:
            logger.warning(
                "Using fallback spaCy model %s (configured: %s)", model, settings.spacy_model
            )
            report.details["pii"] += f" [fallback; configured {settings.spacy_model}]"
    except DetectorError as exc:
        logger.error("PII detector unavailable: %s", exc)
        report.components["pii"] = UNAVAILABLE
        report.details["pii"] = str(exc)

    if injection is None or pii is None:
        return report

    report.orchestrator = AnalysisOrchestrator(
        pii_detector=pii,
        injection_detector=injection,
        scoring_config=settings.scoring,
        thresholds=settings.thresholds,
    )
    return report


def _presidio_model(detector: PIIDetector) -> str | None:
    if isinstance(detector, PresidioPIIDetector):
        return detector.model_name
    if isinstance(detector, CompositePIIDetector):
        for member in detector.members:
            if isinstance(member, PresidioPIIDetector):
                return member.model_name
    return None
