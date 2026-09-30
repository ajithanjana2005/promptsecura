"""PII detection backed by Microsoft Presidio + spaCy.

Presidio and spaCy are imported lazily inside ``PresidioPIIDetector.create``
so the rest of the application (and its tests) can be imported without them.

Model availability is handled explicitly:

* The configured spaCy model and any configured fallbacks are tried in order,
  using only models that are already installed. We check installation
  ourselves before handing the model to Presidio, so startup never triggers
  an unexpected download.
* If Presidio or every candidate model is missing, ``create`` raises
  ``DetectorError`` with an actionable message. The API then reports itself
  as degraded in /health and returns 503 from /api/v1/analyze (fail-closed).
  It never silently skips PII checks.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Sequence

from app.pipeline.base import DetectorError, PIIDetector, PIIEntity


def select_model(candidates: Iterable[str], is_installed: Callable[[str], bool]) -> str | None:
    """Return the first candidate model that is installed, or None."""
    for name in candidates:
        if name and is_installed(name):
            return name
    return None


def _unique(names: Iterable[str]) -> list[str]:
    seen: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.append(name)
    return seen


class PresidioPIIDetector:
    def __init__(
        self,
        analyzer: Any,
        entities: Sequence[str],
        score_threshold: float,
        language: str = "en",
        model_name: str = "unknown",
    ) -> None:
        self._analyzer = analyzer
        self._entities = list(entities)
        self._score_threshold = score_threshold
        self._language = language
        self.model_name = model_name

    @property
    def name(self) -> str:
        return f"presidio({self.model_name})"

    @classmethod
    def create(
        cls,
        spacy_model: str,
        entities: Sequence[str],
        score_threshold: float,
        fallback_models: Sequence[str] = (),
    ) -> "PresidioPIIDetector":
        try:
            import spacy.util
            from presidio_analyzer import AnalyzerEngine
            from presidio_analyzer.nlp_engine import NlpEngineProvider
        except ImportError as exc:
            raise DetectorError(
                "presidio-analyzer/spaCy are not installed. "
                "Run: pip install -r requirements.txt"
            ) from exc

        candidates = _unique([spacy_model, *fallback_models])
        model = select_model(candidates, spacy.util.is_package)
        if model is None:
            raise DetectorError(
                f"No spaCy model installed (tried: {', '.join(candidates)}). "
                f"Run: python -m spacy download {spacy_model}"
            )

        nlp_configuration = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": model}],
        }
        try:
            nlp_engine = NlpEngineProvider(nlp_configuration=nlp_configuration).create_engine()
            analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
            # Warm-up call: surfaces model/recognizer problems at startup
            # instead of on the first user request.
            analyzer.analyze(text="warm-up", language="en")
        except Exception as exc:  # noqa: BLE001 - Presidio/spaCy raise many types
            raise DetectorError(
                f"Could not initialise Presidio with spaCy model '{model}'"
            ) from exc

        return cls(
            analyzer=analyzer,
            entities=entities,
            score_threshold=score_threshold,
            model_name=model,
        )

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

        entities: list[PIIEntity] = []
        for r in results:
            metadata = getattr(r, "recognition_metadata", None) or {}
            recognizer = metadata.get("recognizer_name") if isinstance(metadata, dict) else None
            entities.append(
                PIIEntity(
                    entity_type=str(r.entity_type),
                    start=int(r.start),
                    end=int(r.end),
                    score=float(r.score),
                    source=f"presidio:{recognizer}" if recognizer else "presidio",
                )
            )
        return entities


class CompositePIIDetector:
    """Runs several PII detectors and concatenates their results.

    Overlaps between detectors are resolved later by the orchestrator
    (``redaction.resolve_overlaps``). If any member fails, the whole
    detection fails, so the analysis fails closed.
    """

    def __init__(self, detectors: Sequence[PIIDetector]) -> None:
        if not detectors:
            raise DetectorError("CompositePIIDetector requires at least one detector")
        self._detectors = tuple(detectors)

    @property
    def name(self) -> str:
        return "+".join(d.name for d in self._detectors)

    @property
    def members(self) -> tuple[PIIDetector, ...]:
        return self._detectors

    def detect(self, text: str) -> list[PIIEntity]:
        results: list[PIIEntity] = []
        for detector in self._detectors:
            results.extend(detector.detect(text))
        return results
