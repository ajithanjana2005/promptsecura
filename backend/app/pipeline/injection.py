"""Prompt-injection / jailbreak detection (Phase 1: rule-based).

Rules are loaded from a YAML file (see ``app/rules/injection_rules.yaml``).
Each rule has an id, category, human-readable description, integer weight,
and one or more regular expressions. Patterns are matched case-insensitively
against a matching form of the text (lower-cased, whitespace collapsed to
single spaces), so rules do not need to account for line breaks.

Known limitation: keyword/regex rules can be evaded by paraphrasing and can
produce false positives on benign text. They are a baseline, not semantic
analysis. The ``InjectionDetector`` protocol allows an ML detector to be
added in a later phase without changing the API.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.pipeline.base import DetectorError, InjectionMatch

_WS = re.compile(r"\s+")
_RULE_ID = re.compile(r"^[a-z0-9_]+$")


@dataclass(frozen=True)
class InjectionRule:
    id: str
    category: str
    description: str
    weight: int
    patterns: tuple[re.Pattern[str], ...]


def to_matching_form(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


def parse_rules(data: Any) -> list[InjectionRule]:
    """Validate and compile rule data. Raises ``DetectorError`` on invalid input."""
    if not isinstance(data, dict) or data.get("version") != 1:
        raise DetectorError("Injection rules file must be a mapping with 'version: 1'")
    raw_rules = data.get("rules")
    if not isinstance(raw_rules, list) or not raw_rules:
        raise DetectorError("Injection rules file must contain a non-empty 'rules' list")

    rules: list[InjectionRule] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_rules):
        where = f"rule #{index}"
        if not isinstance(raw, dict):
            raise DetectorError(f"{where}: must be a mapping")
        rule_id = raw.get("id")
        if not isinstance(rule_id, str) or not _RULE_ID.match(rule_id):
            raise DetectorError(f"{where}: 'id' must match [a-z0-9_]+")
        if rule_id in seen:
            raise DetectorError(f"{where}: duplicate id '{rule_id}'")
        seen.add(rule_id)
        where = f"rule '{rule_id}'"

        category = raw.get("category")
        description = raw.get("description")
        weight = raw.get("weight")
        patterns = raw.get("patterns")
        if not isinstance(category, str) or not category:
            raise DetectorError(f"{where}: 'category' must be a non-empty string")
        if not isinstance(description, str) or not description:
            raise DetectorError(f"{where}: 'description' must be a non-empty string")
        if isinstance(weight, bool) or not isinstance(weight, int) or not 1 <= weight <= 100:
            raise DetectorError(f"{where}: 'weight' must be an integer from 1 to 100")
        if not isinstance(patterns, list) or not patterns:
            raise DetectorError(f"{where}: 'patterns' must be a non-empty list")

        compiled: list[re.Pattern[str]] = []
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern:
                raise DetectorError(f"{where}: every pattern must be a non-empty string")
            try:
                compiled.append(re.compile(pattern, re.IGNORECASE))
            except re.error as exc:
                raise DetectorError(f"{where}: invalid regex {pattern!r}: {exc}") from exc

        rules.append(
            InjectionRule(
                id=rule_id,
                category=category,
                description=description,
                weight=weight,
                patterns=tuple(compiled),
            )
        )
    return rules


def load_rules(path: Path) -> list[InjectionRule]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except OSError as exc:
        raise DetectorError(f"Cannot read injection rules file: {path}") from exc
    except yaml.YAMLError as exc:
        raise DetectorError(f"Injection rules file is not valid YAML: {path}") from exc
    return parse_rules(data)


class RuleBasedInjectionDetector:
    name = "rules-v1"

    def __init__(self, rules: list[InjectionRule]) -> None:
        if not rules:
            raise DetectorError("RuleBasedInjectionDetector requires at least one rule")
        self._rules = tuple(rules)

    @classmethod
    def from_file(cls, path: Path) -> "RuleBasedInjectionDetector":
        return cls(load_rules(path))

    @property
    def rules(self) -> tuple[InjectionRule, ...]:
        return self._rules

    def detect(self, text: str) -> list[InjectionMatch]:
        haystack = to_matching_form(text)
        matches: list[InjectionMatch] = []
        for rule in self._rules:
            if any(pattern.search(haystack) for pattern in rule.patterns):
                matches.append(
                    InjectionMatch(
                        rule_id=rule.id,
                        category=rule.category,
                        description=rule.description,
                        weight=rule.weight,
                    )
                )
        return matches
