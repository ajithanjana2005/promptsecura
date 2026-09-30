import assert from "node:assert/strict";
import { test } from "node:test";

import { LABELS, labelFor, stateFromOutcome, tooltipFor } from "../src/content/indicator-state";
import { describeFindings, entityName } from "../src/content/findings";
import { createAnalyzer, isAnalyzeOutcome } from "../src/content/messaging";
import { FAIL_CLOSED_MESSAGE } from "../src/shared/config";
import type { AnalyzeOutcome, AnalyzeResponse } from "../src/shared/types";

const RESPONSE: AnalyzeResponse = {
  request_id: "r1",
  decision: "BLOCK",
  risk_level: "high",
  risk_score: 70,
  reasons: ["Attempts to make the model ignore or override its previous instructions (rule: instruction_override)"],
  pii_entities: [],
  pii_summary: {},
  injection_matches: [],
  score_breakdown: { pii: 0, injection: 70, obfuscation: 0, total: 70 },
  sanitized_prompt: null,
  latency_ms: 2,
  detectors: { pii: "presidio(en_core_web_lg)", injection: "rules-v1" },
};

function fail(kind: "network" | "http", status: number | null): AnalyzeOutcome {
  return { ok: false, error: { kind, message: FAIL_CLOSED_MESSAGE, detail: "d", status, retryable: true } };
}

// --- indicator-state ---------------------------------------------------------

test("labels for each state", () => {
  assert.equal(labelFor({ kind: "idle" }), "");
  assert.equal(labelFor({ kind: "analyzing" }), "Analyzing…");
  const high = stateFromOutcome({ ok: true, response: RESPONSE });
  assert.equal(labelFor(high), "High Risk");
  assert.equal(labelFor(stateFromOutcome({ ok: true, response: { ...RESPONSE, decision: "SANITIZE" } })), "Medium Risk");
  assert.equal(labelFor(stateFromOutcome({ ok: true, response: { ...RESPONSE, decision: "ALLOW" } })), "Safe");
  assert.equal(labelFor(stateFromOutcome(fail("network", null))), "Backend Unavailable");
  assert.equal(labelFor(stateFromOutcome(fail("http", 503))), "Backend Unavailable");
});

test("413 is labelled accurately rather than as backend unavailable", () => {
  assert.equal(labelFor(stateFromOutcome(fail("http", 413))), LABELS.tooLong);
});

test("state follows the decision, including medium scores escalated to BLOCK", () => {
  const s = stateFromOutcome({ ok: true, response: { ...RESPONSE, risk_level: "medium", risk_score: 45 } });
  assert.equal(s.kind, "high");
});

test("tooltip shows score and reasons, and says sending is not blocked", () => {
  const tip = tooltipFor(stateFromOutcome({ ok: true, response: RESPONSE }));
  assert.ok(tip.includes("risk 70/100"));
  assert.ok(tip.includes("instruction_override"));
  assert.ok(tip.includes("not blocked"));
  assert.ok(tooltipFor(stateFromOutcome(fail("network", null))).includes("has not been checked"));
});

// --- messaging -----------------------------------------------------------------

test("analyzer sends the analyze message for the site and returns a valid reply", async () => {
  const sent: unknown[] = [];
  const analyze = createAnalyzer("chatgpt", async (m) => {
    sent.push(m);
    return { ok: true, response: RESPONSE };
  });
  const outcome = await analyze("hello");
  assert.deepEqual(sent, [{ type: "promptsecura/analyze", payload: { prompt: "hello", site: "chatgpt" } }]);
  assert.equal(outcome.ok, true);
});

test("messaging errors (e.g. extension reloaded) fail closed", async () => {
  const analyze = createAnalyzer("chatgpt", async () => {
    throw new Error("Extension context invalidated.");
  });
  const outcome = await analyze("secret prompt");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.message, FAIL_CLOSED_MESSAGE);
    assert.ok(!outcome.error.detail.includes("secret"));
  }
});

test("malformed or missing replies fail closed", async () => {
  for (const reply of [undefined, null, {}, { ok: true }, { ok: true, response: { decision: "ALLOW" } }, { ok: false }]) {
    const outcome = await createAnalyzer("chatgpt", async () => reply)("x");
    assert.equal(outcome.ok, false, JSON.stringify(reply));
  }
});

test("isAnalyzeOutcome accepts real failures from the service worker", () => {
  assert.ok(isAnalyzeOutcome(fail("http", 503)));
  assert.ok(isAnalyzeOutcome({ ok: true, response: RESPONSE }));
});

// --- enforcement panel findings --------------------------------------------------

test("findings name entity types and threat categories, never values", () => {
  const f = describeFindings({
    ...RESPONSE,
    risk_level: "high",
    pii_summary: { PHONE_NUMBER: 1, EMAIL_ADDRESS: 2 },
    pii_entities: [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 5, score: 1, placeholder: "[EMAIL]", source: "presidio" },
    ],
    injection_matches: [
      { rule_id: "instruction_override", category: "prompt_injection", description: "Overrides instructions", weight: 70 },
    ],
  });
  assert.deepEqual(f.sensitiveData, ["Email address ×2", "Phone number ×1"]);
  assert.deepEqual(f.threats, ["Prompt injection: Overrides instructions"]);
  assert.equal(f.riskLine, "Risk 70/100 · High");
  assert.equal(entityName("CUSTOM_TYPE"), "CUSTOM_TYPE");
});
