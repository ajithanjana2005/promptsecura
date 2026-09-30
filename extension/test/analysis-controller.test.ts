import assert from "node:assert/strict";
import { test } from "node:test";

import { AnalysisController, type Timers } from "../src/content/analysis-controller";
import type { IndicatorState } from "../src/content/indicator-state";
import type { AnalyzeOutcome, AnalyzeResponse, Decision } from "../src/shared/types";

class FakeTimers implements Timers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
}

function response(decision: Decision, score: number): AnalyzeResponse {
  return {
    request_id: "r",
    decision,
    risk_level: score <= 30 ? "low" : score <= 60 ? "medium" : "high",
    risk_score: score,
    reasons: [`reason for ${decision}`],
    pii_entities: [],
    pii_summary: {},
    injection_matches: [],
    score_breakdown: { pii: 0, injection: score, obfuscation: 0, total: score },
    sanitized_prompt: null,
    latency_ms: 1,
    detectors: {},
  };
}

/** analyze() whose promises the test resolves explicitly. */
function controllableAnalyze() {
  const calls: { text: string; resolve: (o: AnalyzeOutcome) => void; reject: (e: unknown) => void }[] = [];
  const analyze = (text: string) =>
    new Promise<AnalyzeOutcome>((resolve, reject) => calls.push({ text, resolve, reject }));
  return { analyze, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const timers = new FakeTimers();
  const { analyze, calls } = controllableAnalyze();
  const states: IndicatorState[] = [];
  const controller = new AnalysisController({
    analyze,
    render: (s) => states.push(s),
    typingDebounceMs: 600,
    pasteDebounceMs: 150,
    timers,
  });
  const kinds = () => states.map((s) => s.kind);
  return { timers, calls, states, kinds, controller };
}

test("typing is debounced into a single request for the latest text", async () => {
  const { timers, calls, controller, kinds } = setup();
  controller.onTextChanged("h", "input");
  timers.advance(200);
  controller.onTextChanged("he", "input");
  timers.advance(200);
  controller.onTextChanged("hello", "input");
  timers.advance(599);
  assert.equal(calls.length, 0);
  timers.advance(1);
  assert.deepEqual(calls.map((c) => c.text), ["hello"]);
  calls[0]!.resolve({ ok: true, response: response("ALLOW", 0) });
  await flush();
  assert.deepEqual(kinds(), ["analyzing", "safe"]);
});

test("paste uses the shorter debounce", () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("pasted text", "paste");
  timers.advance(150);
  assert.equal(calls.length, 1);
});

test("an input event followed by a paste read of the same text still uses the paste delay", () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("pasted text", "input");
  controller.onTextChanged("pasted text", "paste");
  timers.advance(150);
  assert.equal(calls.length, 1);
});

test("decisions map to Safe / Medium Risk / High Risk", async () => {
  for (const [decision, kind] of [["ALLOW", "safe"], ["SANITIZE", "medium"], ["BLOCK", "high"]] as const) {
    const { timers, calls, controller } = setup();
    controller.onTextChanged("text", "input");
    timers.advance(600);
    calls[0]!.resolve({ ok: true, response: response(decision, 42) });
    await flush();
    assert.equal(controller.state.kind, kind);
  }
});

test("stale responses for text that has changed are discarded", async () => {
  const { timers, calls, controller, kinds } = setup();
  controller.onTextChanged("first", "input");
  timers.advance(600);
  controller.onTextChanged("first and more", "input");
  timers.advance(600);
  assert.equal(calls.length, 2);
  calls[1]!.resolve({ ok: true, response: response("ALLOW", 0) });
  await flush();
  calls[0]!.resolve({ ok: true, response: response("BLOCK", 90) }); // late, stale
  await flush();
  assert.equal(controller.state.kind, "safe");
  assert.ok(!kinds().includes("high"));
});

test("clearing the editor hides the indicator and drops in-flight results", async () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("secret", "input");
  timers.advance(600);
  controller.onTextChanged("", "poll");
  assert.equal(controller.state.kind, "idle");
  calls[0]!.resolve({ ok: true, response: response("BLOCK", 90) });
  await flush();
  assert.equal(controller.state.kind, "idle");
});

test("whitespace-only or missing editor text sends nothing", () => {
  const { timers, calls, controller, states } = setup();
  controller.onTextChanged("   \n ", "input");
  controller.onTextChanged(null, "poll");
  timers.advance(5000);
  assert.equal(calls.length, 0);
  assert.equal(states.length, 0); // stays idle, nothing rendered
});

test("unchanged text (poll) is not re-sent", async () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("same", "input");
  timers.advance(600);
  calls[0]!.resolve({ ok: true, response: response("ALLOW", 0) });
  await flush();
  controller.onTextChanged("same", "poll");
  controller.onTextChanged("same", "poll");
  timers.advance(5000);
  assert.equal(calls.length, 1);
});

test("returning to the last analyzed text reuses its verdict without a request", async () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("abc", "input");
  timers.advance(600);
  calls[0]!.resolve({ ok: true, response: response("SANITIZE", 40) });
  await flush();
  controller.onTextChanged("abcd", "input");
  assert.equal(controller.state.kind, "analyzing");
  controller.onTextChanged("abc", "input");
  assert.equal(controller.state.kind, "medium");
  timers.advance(5000);
  assert.equal(calls.length, 1);
});

test("backend failure shows Backend Unavailable, never Safe, and is not cached", async () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("x", "input");
  timers.advance(600);
  calls[0]!.resolve({
    ok: false,
    error: { kind: "network", message: "m", detail: "TypeError", status: null, retryable: true },
  });
  await flush();
  assert.equal(controller.state.kind, "unavailable");
  controller.onTextChanged("xy", "input");
  controller.onTextChanged("x", "input"); // back to the failed text: must retry, not reuse
  timers.advance(600);
  assert.equal(calls.length, 2);
});

test("a thrown analyze() error also fails closed", async () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("x", "input");
  timers.advance(600);
  calls[0]!.reject(new Error("boom"));
  await flush();
  assert.equal(controller.state.kind, "unavailable");
});

test("dispose stops further requests and renders", async () => {
  const { timers, calls, controller, states } = setup();
  controller.onTextChanged("x", "input");
  const rendered = states.length;
  controller.dispose();
  timers.advance(600);
  controller.onTextChanged("y", "input");
  assert.equal(calls.length, 0);
  assert.equal(states.length, rendered);
});

test("analyzeNow checks immediately (no debounce) and returns the outcome", async () => {
  const { timers, calls, controller, kinds } = setup();
  const pending = controller.analyzeNow("final text");
  assert.deepEqual(calls.map((c) => c.text), ["final text"]); // no timer needed
  calls[0]!.resolve({ ok: true, response: response("BLOCK", 80) });
  const outcome = await pending;
  assert.equal(outcome.ok && outcome.response.decision, "BLOCK");
  assert.deepEqual(kinds(), ["analyzing", "high"]);
  timers.advance(5000);
  assert.equal(calls.length, 1);
});

test("analyzeNow cancels a pending debounced check for the same text", () => {
  const { timers, calls, controller } = setup();
  controller.onTextChanged("typed", "input");
  void controller.analyzeNow("typed");
  timers.advance(5000);
  assert.deepEqual(calls.map((c) => c.text), ["typed"]);
});

test("analyzeNow returns failures (fail-closed) instead of throwing", async () => {
  const { calls, controller } = setup();
  const pending = controller.analyzeNow("x");
  calls[0]!.reject(new Error("boom"));
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(controller.state.kind, "unavailable");
});
