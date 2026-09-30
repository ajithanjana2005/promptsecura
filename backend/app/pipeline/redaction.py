"""Overlap resolution and placeholder redaction for detected PII.

Presidio can return overlapping spans (for example an EMAIL_ADDRESS and a
URL covering "gmail.com" inside it). Before scoring and redaction we keep a
non-overlapping set, preferring higher confidence, then longer spans.

Redaction is implemented here rather than with ``presidio-anonymizer`` so
that it is deterministic, dependency-free and unit-testable on its own.
"""

from __future__ import annotations

from typing import Iterable

from app.pipeline.base import PIIEntity

PLACEHOLDERS: dict[str, str] = {
    "EMAIL_ADDRESS": "[EMAIL]",
    "PHONE_NUMBER": "[PHONE]",
    "PERSON": "[PERSON]",
    "CREDIT_CARD": "[CREDIT_CARD]",
    "IP_ADDRESS": "[IP_ADDRESS]",
    "URL": "[URL]",
}


def placeholder_for(entity_type: str) -> str:
    return PLACEHOLDERS.get(entity_type, f"[{entity_type}]")


def resolve_overlaps(entities: Iterable[PIIEntity]) -> list[PIIEntity]:
    """Return a non-overlapping subset of ``entities``, sorted by start offset."""
    ranked = sorted(
        (e for e in entities if e.end > e.start),
        key=lambda e: (-e.score, -(e.end - e.start), e.start),
    )
    kept: list[PIIEntity] = []
    for candidate in ranked:
        if all(candidate.end <= k.start or candidate.start >= k.end for k in kept):
            kept.append(candidate)
    return sorted(kept, key=lambda e: e.start)


def redact(text: str, entities: Iterable[PIIEntity]) -> str:
    """Replace each entity span in ``text`` with its placeholder.

    ``entities`` must already be non-overlapping (see ``resolve_overlaps``)
    and must have offsets within ``text``.
    """
    ordered = sorted(entities, key=lambda e: e.start)
    parts: list[str] = []
    cursor = 0
    for entity in ordered:
        if entity.start < cursor or entity.end > len(text) or entity.start < 0:
            raise ValueError("Entities must be non-overlapping and within the text bounds")
        parts.append(text[cursor : entity.start])
        parts.append(placeholder_for(entity.entity_type))
        cursor = entity.end
    parts.append(text[cursor:])
    return "".join(parts)
