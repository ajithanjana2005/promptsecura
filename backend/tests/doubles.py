"""Test doubles. NOT production detectors.

These let pipeline and API tests run without Presidio/spaCy. They are only
imported from tests; production PII detection is PresidioPIIDetector.
Real Presidio behaviour is covered by tests/test_pii_presidio.py.
"""

from __future__ import annotations

import re

from app.pipeline.base import DetectorError, PIIEntity

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


class FixedPIIDetector:
    """Returns a preset list of entities regardless of input."""

    name = "test-fixed"

    def __init__(self, entities: list[PIIEntity] | None = None) -> None:
        self.entities = entities or []
        self.calls = 0

    def detect(self, text: str) -> list[PIIEntity]:
        self.calls += 1
        return list(self.entities)


class EmailOnlyPIIDetector:
    """Finds email addresses with a simple regex. Test use only."""

    name = "test-email-regex"

    def detect(self, text: str) -> list[PIIEntity]:
        return [
            PIIEntity("EMAIL_ADDRESS", m.start(), m.end(), 1.0) for m in _EMAIL.finditer(text)
        ]


class FailingDetector:
    """Always raises, to exercise fail-closed behaviour."""

    name = "test-failing"

    def __init__(self, exc: Exception | None = None) -> None:
        self.exc = exc or DetectorError("simulated failure")

    def detect(self, text: str):
        raise self.exc


class FakeRecognizerResult:
    """Mimics the attributes of presidio_analyzer.RecognizerResult."""

    def __init__(self, entity_type: str, start: int, end: int, score: float) -> None:
        self.entity_type = entity_type
        self.start = start
        self.end = end
        self.score = score


class FakeAnalyzer:
    """Mimics AnalyzerEngine.analyze to test our wrapper's mapping, not Presidio."""

    def __init__(self, results=None, exc: Exception | None = None) -> None:
        self.results = results or []
        self.exc = exc
        self.last_kwargs: dict | None = None

    def analyze(self, **kwargs):
        self.last_kwargs = kwargs
        if self.exc:
            raise self.exc
        return self.results
