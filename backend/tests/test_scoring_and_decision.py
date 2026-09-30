import pytest

from app.pipeline.base import Decision, InjectionMatch, PIIEntity, RiskLevel, ScoreBreakdown
from app.pipeline.decision import Thresholds, decide, risk_level_for
from app.pipeline.scoring import ScoringConfig, score_signals

CFG = ScoringConfig()
T = Thresholds()


def _pii(entity_type: str, start: int = 0) -> PIIEntity:
    return PIIEntity(entity_type, start, start + 5, 0.9)


def _inj(weight: int, rule_id: str = "r") -> InjectionMatch:
    return InjectionMatch(rule_id, "prompt_injection", "desc", weight)


# --- scoring ----------------------------------------------------------------

def test_no_signals_scores_zero():
    b = score_signals([], [], 0, CFG)
    assert (b.pii, b.injection, b.obfuscation, b.total) == (0, 0, 0, 0)


def test_single_email_uses_configured_weight():
    assert score_signals([_pii("EMAIL_ADDRESS")], [], 0, CFG).pii == 35


def test_repeat_entities_add_repeat_weight():
    b = score_signals([_pii("PERSON", 0), _pii("PERSON", 10), _pii("PERSON", 20)], [], 0, CFG)
    assert b.pii == 15 + 5 + 5


def test_unknown_entity_type_uses_default_weight():
    assert score_signals([_pii("SOMETHING_NEW")], [], 0, CFG).pii == 20


def test_pii_is_capped():
    entities = [_pii("CREDIT_CARD", 0), _pii("EMAIL_ADDRESS", 10), _pii("PHONE_NUMBER", 20)]
    assert score_signals(entities, [], 0, CFG).pii == CFG.pii_cap


def test_injection_weights_sum_and_cap():
    assert score_signals([], [_inj(25), _inj(30)], 0, CFG).injection == 55
    assert score_signals([], [_inj(70), _inj(65)], 0, CFG).injection == 100


def test_obfuscation_weight_applies_when_hidden_chars_removed():
    assert score_signals([], [], 3, CFG).obfuscation == CFG.obfuscation_weight


def test_total_is_capped_at_100():
    b = score_signals([_pii("CREDIT_CARD")], [_inj(70), _inj(65)], 1, CFG)
    assert b.total == 100


def test_scoring_config_rejects_negative_weights():
    with pytest.raises(ValueError):
        ScoringConfig(pii_cap=-1)


# --- thresholds / risk level --------------------------------------------------

def test_risk_level_band_edges():
    assert risk_level_for(0, T) is RiskLevel.LOW
    assert risk_level_for(30, T) is RiskLevel.LOW
    assert risk_level_for(31, T) is RiskLevel.MEDIUM
    assert risk_level_for(60, T) is RiskLevel.MEDIUM
    assert risk_level_for(61, T) is RiskLevel.HIGH
    assert risk_level_for(100, T) is RiskLevel.HIGH


def test_invalid_thresholds_rejected():
    for allow_max, sanitize_max in [(60, 30), (30, 30), (-1, 60), (30, 101)]:
        with pytest.raises(ValueError):
            Thresholds(allow_max=allow_max, sanitize_max=sanitize_max)


# --- decision ---------------------------------------------------------------

def _b(pii=0, injection=0, obfuscation=0) -> ScoreBreakdown:
    return ScoreBreakdown(pii, injection, obfuscation, min(100, pii + injection + obfuscation))


def test_low_score_allows():
    assert decide(_b(), False, T).decision is Decision.ALLOW
    assert decide(_b(pii=15), True, T).decision is Decision.ALLOW


def test_medium_pii_only_sanitizes():
    result = decide(_b(pii=50), True, T)
    assert result.decision is Decision.SANITIZE
    assert result.risk_level is RiskLevel.MEDIUM


def test_medium_without_pii_escalates_to_block():
    result = decide(_b(injection=50), False, T)
    assert result.decision is Decision.BLOCK
    assert result.risk_level is RiskLevel.MEDIUM


def test_medium_with_pii_but_high_residual_escalates_to_block():
    # Removing PII (20) would still leave injection (35) above allow_max.
    result = decide(_b(pii=20, injection=35), True, T)
    assert result.decision is Decision.BLOCK


def test_high_score_blocks():
    result = decide(_b(injection=70), False, T)
    assert result.decision is Decision.BLOCK
    assert result.risk_level is RiskLevel.HIGH


def test_custom_thresholds_are_respected():
    strict = Thresholds(allow_max=10, sanitize_max=40)
    assert decide(_b(pii=15), True, strict).decision is Decision.SANITIZE
    assert decide(_b(pii=45), True, strict).decision is Decision.BLOCK
