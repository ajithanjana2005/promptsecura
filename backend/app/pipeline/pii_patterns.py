"""Supplementary pattern-based PII detectors (stdlib only).

``ContextualPhoneDetector`` covers a gap in phone detection: bare digit
sequences such as "9876543210" (the example in the PromptSecura workflow
image), which Presidio's default phone recognizer may not report depending
on its region settings.

To avoid flagging order numbers, IDs, etc., a candidate is reported ONLY
when a phone-related context word appears shortly before it ("my phone is
...", "call me on ...", "WhatsApp: ..."). Without context, nothing is
reported. This detector runs alongside Presidio (never instead of it); when
both report the same span, overlap resolution keeps a single entity.
"""

from __future__ import annotations

import re
from typing import Sequence

from app.pipeline.base import PIIEntity

DEFAULT_PHONE_CONTEXT_WORDS: tuple[str, ...] = (
    "phone",
    "mobile",
    "cell",
    "cellphone",
    "call",
    "contact",
    "whatsapp",
    "tel",
    "telephone",
    "sms",
    "text me",
    "reach me",
)

# Optional +<country code>, then 10 digits (contiguous, 5-5, or 3-3-4).
_CANDIDATE = re.compile(
    r"(?<![\w+])"
    r"(?:\+\d{1,3}[ -]?)?"
    r"(?:\d{10}|\d{5}[ -]\d{5}|\d{3}[ -]\d{3}[ -]\d{4})"
    r"(?![\w])"
)


class ContextualPhoneDetector:
    name = "contextual-phone"

    def __init__(
        self,
        context_words: Sequence[str] = DEFAULT_PHONE_CONTEXT_WORDS,
        window: int = 40,
        score: float = 0.6,
    ) -> None:
        if window <= 0:
            raise ValueError("window must be positive")
        if not 0.0 < score <= 1.0:
            raise ValueError("score must be in (0, 1]")
        words = [w.strip().lower() for w in context_words if w.strip()]
        if not words:
            raise ValueError("context_words must not be empty")
        self._context = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b")
        self._window = window
        self._score = score

    def detect(self, text: str) -> list[PIIEntity]:
        entities: list[PIIEntity] = []
        for match in _CANDIDATE.finditer(text):
            before = text[max(0, match.start() - self._window) : match.start()].lower()
            if self._context.search(before):
                entities.append(
                    PIIEntity(
                        entity_type="PHONE_NUMBER",
                        start=match.start(),
                        end=match.end(),
                        score=self._score,
                        source="pattern:contextual_phone",
                    )
                )
        return entities
