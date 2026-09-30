"""PII detection backed by Microsoft Presidio + spaCy.

Presidio is imported lazily inside ``PresidioPIIDetector.create`` so the rest
of the application (and its tests) can be imported without Presidio
installed. If Presidio or the spaCy model is missing, ``create`` raises
``DetectorError``; the API then reports itself as degraded and refuses to
return analysis results (fail-closed) instead of silently skipping PII checks.
"""

from __future__ import annotations

from typing import Any, Sequence

from app.pipeline.base import DetectorError, PIIEntity


class PresidioPIIDetector:
    name = "presidio"

    def __init__(
        self,
        analyzer: Any,
        entities: Sequence[str],
        score_threshold: float,
        language: str = "en",
    ) -> None:
        self._analyzer = analyzer
        self._entities = list(entities)
        self._score_threshold = score_threshold
        self._language = language

    @classmethod
    def create(
        cls,
        spacy_model: str,
        entities: Sequence[str],
        score_threshold: float,
    ) -> "PresidioPIIDetector":
        try:
            from presidio_analyzer import AnalyzerEngine
            from presidio_analyzer.nlp_engine import NlpEngineProvider
        except ImportError as exc:
            raise DetectorError(
                "presidio-analyzer is not installed (pip install -r requirements.txt)"
            ) from exc

        nlp_configuration = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": spacy_model}],
        }
        try:
            nlp_engine = NlpEngineProvider(nlp_configuration=nlp_configuration).create_engine()
            analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
            # Warm-up call: surfaces model/recognizer problems at startup
            # instead of on the first user request.
            analyzer.analyze(text="warm-up", language="en")
        except Exception as exc:  # noqa: BLE001 - Presidio/spaCy raise many types
            raise DetectorError(
                f"Could not initialise Presidio with spaCy model '{spacy_model}'. "
                f"Install it with: python -m spacy download {spacy_model}"
            ) from exc

        return cls(analyzer=analyzer, entities=entities, score_threshold=score_threshold)

    def detect(self, text: str) -> list[PIIEntity]:
        if not text:
            return []
        try:
            results = self._analyzer.analyze(
                text=text,
                entities=self._entities,
                language=self._language,
                score_threshold=self._score_threshold,
            )
        except Exception as exc:  # noqa: BLE001
            # Never include the text in the error message.
            raise DetectorError("Presidio analysis failed") from exc

        return [
            PIIEntity(
                entity_type=str(r.entity_type),
                start=int(r.start),
                end=int(r.end),
                score=float(r.score),
            )
            for r in results
        ]
