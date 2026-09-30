from pathlib import Path

import pytest

from app.config import DEFAULT_CORS_ORIGIN_REGEX, DEFAULT_RULES_PATH, Settings


def test_defaults():
    s = Settings.from_env({})
    assert s.thresholds.allow_max == 30
    assert s.thresholds.sanitize_max == 60
    assert s.spacy_model == "en_core_web_lg"
    assert s.injection_rules_path == DEFAULT_RULES_PATH
    assert s.cors_origin_regex == DEFAULT_CORS_ORIGIN_REGEX
    assert s.cors_origins == ()
    assert "EMAIL_ADDRESS" in s.pii_entities
    assert DEFAULT_RULES_PATH.is_file()


def test_env_overrides():
    s = Settings.from_env(
        {
            "PROMPTSECURA_ALLOW_MAX": "20",
            "PROMPTSECURA_SANITIZE_MAX": "50",
            "PROMPTSECURA_SPACY_MODEL": "en_core_web_sm",
            "PROMPTSECURA_PII_ENTITIES": "EMAIL_ADDRESS, PHONE_NUMBER",
            "PROMPTSECURA_CORS_ORIGINS": "http://localhost:5173,https://example.test",
            "PROMPTSECURA_CORS_ORIGIN_REGEX": "",
            "PROMPTSECURA_LOG_LEVEL": "debug",
            "PROMPTSECURA_INJECTION_RULES_PATH": "/tmp/rules.yaml",
            "PROMPTSECURA_MAX_PROMPT_CHARS": "500",
            "PROMPTSECURA_PII_SCORE_THRESHOLD": "0.6",
        }
    )
    assert (s.thresholds.allow_max, s.thresholds.sanitize_max) == (20, 50)
    assert s.spacy_model == "en_core_web_sm"
    assert s.pii_entities == ("EMAIL_ADDRESS", "PHONE_NUMBER")
    assert s.cors_origins == ("http://localhost:5173", "https://example.test")
    assert s.cors_origin_regex is None
    assert s.log_level == "DEBUG"
    assert s.injection_rules_path == Path("/tmp/rules.yaml")
    assert s.max_prompt_chars == 500
    assert s.pii_score_threshold == 0.6


def test_invalid_values_raise():
    bad_envs = [
        {"PROMPTSECURA_ALLOW_MAX": "abc"},
        {"PROMPTSECURA_ALLOW_MAX": "70"},  # above sanitize_max
        {"PROMPTSECURA_PII_SCORE_THRESHOLD": "1.5"},
        {"PROMPTSECURA_MAX_PROMPT_CHARS": "0"},
        {"PROMPTSECURA_LOG_LEVEL": "LOUD"},
        {"PROMPTSECURA_PII_ENTITIES": " , "},
    ]
    for env in bad_envs:
        with pytest.raises(ValueError):
            Settings.from_env(env)
