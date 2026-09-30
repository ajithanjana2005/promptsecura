"""Tests for redaction and for our Presidio *wrapper* logic.

The wrapper tests use a FakeAnalyzer, so they verify how PresidioPIIDetector
maps and guards results, not Presidio's own detection quality. Real Presidio
detection is tested in test_pii_presidio.py.
"""

import pytest

from app.pipeline.base import DetectorError, PIIEntity
from app.pipeline.pii import PresidioPIIDetector
from app.pipeline.redaction import placeholder_for, redact, resolve_overlaps
from tests.doubles import FakeAnalyzer, FakeRecognizerResult

TEXT = "My email is anjana@gmail.com and my phone number is 9876543210."
EMAIL = PIIEntity("EMAIL_ADDRESS", 12, 28, 1.0)
PHONE = PIIEntity("PHONE_NUMBER", 52, 62, 0.75)


def test_offsets_used_in_these_tests_are_correct():
    assert TEXT[EMAIL.start:EMAIL.end] == "anjana@gmail.com"
    assert TEXT[PHONE.start:PHONE.end] == "9876543210"


def test_redact_replaces_spans_with_placeholders():
    assert redact(TEXT, [PHONE, EMAIL]) == (
        "My email is [EMAIL] and my phone number is [PHONE]."
    )


def test_redact_with_no_entities_returns_text():
    assert redact(TEXT, []) == TEXT


def test_redact_rejects_overlapping_entities():
    with pytest.raises(ValueError):
        redact(TEXT, [EMAIL, PIIEntity("URL", 19, 28, 0.5)])


def test_resolve_overlaps_prefers_higher_score():
    url_inside_email = PIIEntity("URL", 19, 28, 0.5)  # "gmail.com"
    person_inside_email = PIIEntity("PERSON", 12, 18, 0.85)  # "anjana"
    kept = resolve_overlaps([url_inside_email, EMAIL, PHONE, person_inside_email])
    assert kept == [EMAIL, PHONE]


def test_resolve_overlaps_prefers_longer_span_on_equal_score():
    short = PIIEntity("PERSON", 0, 4, 0.8)
    long = PIIEntity("PERSON", 0, 10, 0.8)
    assert resolve_overlaps([short, long]) == [long]


def test_resolve_overlaps_drops_empty_spans():
    assert resolve_overlaps([PIIEntity("PERSON", 5, 5, 0.9)]) == []


def test_placeholder_for_unknown_type():
    assert placeholder_for("US_SSN") == "[US_SSN]"


def test_presidio_wrapper_maps_results_and_passes_settings():
    fake = FakeAnalyzer([FakeRecognizerResult("EMAIL_ADDRESS", 12, 28, 1.0)])
    detector = PresidioPIIDetector(fake, entities=["EMAIL_ADDRESS"], score_threshold=0.4)
    assert detector.detect(TEXT) == [PIIEntity("EMAIL_ADDRESS", 12, 28, 1.0, source="presidio")]
    assert fake.last_kwargs == {
        "text": TEXT,
        "entities": ["EMAIL_ADDRESS"],
        "language": "en",
        "score_threshold": 0.4,
    }


def test_presidio_wrapper_skips_empty_text():
    fake = FakeAnalyzer()
    assert PresidioPIIDetector(fake, ["EMAIL_ADDRESS"], 0.4).detect("") == []
    assert fake.last_kwargs is None


def test_presidio_wrapper_error_does_not_leak_text():
    fake = FakeAnalyzer(exc=RuntimeError(f"boom {TEXT}"))
    detector = PresidioPIIDetector(fake, ["EMAIL_ADDRESS"], 0.4)
    with pytest.raises(DetectorError) as info:
        detector.detect(TEXT)
    assert "anjana" not in str(info.value)


def test_presidio_wrapper_records_recognizer_name_as_source():
    fake = FakeAnalyzer([FakeRecognizerResult("EMAIL_ADDRESS", 12, 28, 1.0, "EmailRecognizer")])
    detector = PresidioPIIDetector(fake, ["EMAIL_ADDRESS"], 0.4, model_name="en_core_web_lg")
    assert detector.detect(TEXT)[0].source == "presidio:EmailRecognizer"
    assert detector.name == "presidio(en_core_web_lg)"


def test_redact_all_six_supported_types_uses_expected_placeholders():
    text = "A B C D E F"
    types = ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON", "CREDIT_CARD", "IP_ADDRESS", "URL"]
    entities = [PIIEntity(t, i * 2, i * 2 + 1, 0.9) for i, t in enumerate(types)]
    assert redact(text, entities) == "[EMAIL] [PHONE] [PERSON] [CREDIT_CARD] [IP_ADDRESS] [URL]"
