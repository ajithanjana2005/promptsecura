"""PII detection plumbing tests that run without Presidio installed.

Real Presidio detection quality is covered in test_pii_presidio.py.
"""

from pathlib import Path

import pytest

from app.config import Settings
from app.pipeline.base import AnalysisIncompleteError, Decision, DetectorError, PIIEntity
from app.pipeline.factory import build_orchestrator
from app.pipeline.pii import CompositePIIDetector, select_model
from app.pipeline.pii_patterns import ContextualPhoneDetector
from tests.doubles import FailingDetector, FixedPIIDetector

# --- spaCy model selection ---------------------------------------------------


def test_select_model_prefers_first_installed():
    installed = {"en_core_web_sm"}
    assert select_model(["en_core_web_lg", "en_core_web_sm"], installed.__contains__) == (
        "en_core_web_sm"
    )
    assert select_model(["en_core_web_lg", "en_core_web_sm"], lambda _: True) == "en_core_web_lg"


def test_select_model_returns_none_when_nothing_installed():
    assert select_model(["en_core_web_lg", "en_core_web_sm"], lambda _: False) is None
    assert select_model([], lambda _: True) is None


# --- startup / availability ---------------------------------------------------


def test_missing_model_makes_pii_unavailable_and_fails_closed():
    # Works both without Presidio (not installed) and with it (model missing).
    report = build_orchestrator(
        Settings(spacy_model="promptsecura_missing_model", spacy_model_fallbacks=())
    )
    assert report.orchestrator is None
    assert report.components["pii"] == "unavailable"
    assert report.components["injection"] == "ready"
    assert report.details["pii"]  # actionable message, e.g. how to install


def test_missing_rules_file_makes_injection_unavailable():
    report = build_orchestrator(
        Settings(
            spacy_model="promptsecura_missing_model",
            spacy_model_fallbacks=(),
            injection_rules_path=Path("/nonexistent/rules.yaml"),
        )
    )
    assert report.orchestrator is None
    assert report.components["injection"] == "unavailable"


# --- composite detector --------------------------------------------------------


def test_composite_concatenates_results_and_names():
    a = FixedPIIDetector([PIIEntity("EMAIL_ADDRESS", 0, 5, 1.0)])
    b = FixedPIIDetector([PIIEntity("PHONE_NUMBER", 10, 20, 0.6)])
    composite = CompositePIIDetector([a, b])
    assert [e.entity_type for e in composite.detect("x")] == ["EMAIL_ADDRESS", "PHONE_NUMBER"]
    assert composite.name == "test-fixed+test-fixed"
    assert composite.members == (a, b)


def test_composite_fails_if_any_member_fails():
    composite = CompositePIIDetector([FixedPIIDetector(), FailingDetector()])
    with pytest.raises(DetectorError):
        composite.detect("x")


def test_composite_requires_members():
    with pytest.raises(DetectorError):
        CompositePIIDetector([])


# --- contextual phone detector ---------------------------------------------------

PHONE = ContextualPhoneDetector()


def _spans(text):
    return [text[e.start : e.end] for e in PHONE.detect(text)]


def test_detects_bare_ten_digit_number_from_workflow_example():
    text = "My email is anjana@gmail.com and my phone number is 9876543210."
    entities = PHONE.detect(text)
    assert [text[e.start : e.end] for e in entities] == ["9876543210"]
    assert entities[0].entity_type == "PHONE_NUMBER"
    assert entities[0].source == "pattern:contextual_phone"


def test_detects_common_formats_with_context():
    assert _spans("Call me on +91 98765 43210 later") == ["+91 98765 43210"]
    assert _spans("WhatsApp: +919876543210") == ["+919876543210"]
    assert _spans("mobile 555-123-4567") == ["555-123-4567"]
    assert _spans("contact 98765-43210") == ["98765-43210"]


def test_ignores_numbers_without_phone_context():
    assert _spans("Order number 9876543210 has shipped") == []
    assert _spans("Invoice 1234567890 is due") == []


def test_ignores_digit_runs_that_are_not_ten_digits():
    assert _spans("my phone is 12345") == []
    assert _spans("my phone is 123456789012345") == []  # part of a longer number
    assert _spans("my phone is ID9876543210") == []


def test_context_must_be_within_window():
    far = "phone " + "x " * 40 + "9876543210"
    assert _spans(far) == []


def test_contextual_phone_rejects_bad_config():
    with pytest.raises(ValueError):
        ContextualPhoneDetector(window=0)
    with pytest.raises(ValueError):
        ContextualPhoneDetector(score=0)
    with pytest.raises(ValueError):
        ContextualPhoneDetector(context_words=[" "])


# --- integration through the orchestrator (PII stage = doubles + real pattern) ---


def _orchestrator(pii):
    from app.config import DEFAULT_RULES_PATH
    from app.pipeline.decision import Thresholds
    from app.pipeline.injection import RuleBasedInjectionDetector
    from app.pipeline.orchestrator import AnalysisOrchestrator
    from app.pipeline.scoring import ScoringConfig

    return AnalysisOrchestrator(
        pii_detector=pii,
        injection_detector=RuleBasedInjectionDetector.from_file(DEFAULT_RULES_PATH),
        scoring_config=ScoringConfig(),
        thresholds=Thresholds(),
    )


def test_overlapping_phone_from_two_detectors_is_counted_once():
    text = "my phone is 9876543210"
    presidio_like = FixedPIIDetector([PIIEntity("PHONE_NUMBER", 12, 22, 0.75, "presidio")])
    result = _orchestrator(CompositePIIDetector([presidio_like, PHONE])).analyze(text, "chatgpt")
    assert len(result.pii_entities) == 1
    assert result.pii_entities[0].source == "presidio"  # higher score wins
    assert result.sanitized_prompt == "my phone is [PHONE]"
    assert result.decision is Decision.SANITIZE


def test_member_failure_fails_the_whole_analysis_closed():
    with pytest.raises(AnalysisIncompleteError):
        _orchestrator(CompositePIIDetector([PHONE, FailingDetector()])).analyze("hi", "chatgpt")
