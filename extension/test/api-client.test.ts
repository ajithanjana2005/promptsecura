import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient, isAnalyzeResponse } from "../src/background/api-client";
import { FAIL_CLOSED_MESSAGE } from "../src/shared/config";
import type { AnalyzeOutcome, AnalyzeResponse } from "../src/shared/types";

/** A response shaped exactly like the backend's AnalyzeResponse. */
function backendResponse(overrides: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    request_id: "abc123",
    decision: "SANITIZE",
    risk_level: "medium",
    risk_score: 35,
    reasons: ["Sensitive information detected: EMAIL_ADDRESS x1"],
    pii_entities: [
      {
        entity_type: "EMAIL_ADDRESS",
        start: 6,
        end: 22,
        score: 1,
        placeholder: "[EMAIL]",
        source: "presidio:EmailRecognizer",
      },
    ],
    pii_summary: { EMAIL_ADDRESS: 1 },
    injection_matches: [],
    score_breakdown: { pii: 35, injection: 0, obfuscation: 0, total: 35 },
    sanitized_prompt: "Email [EMAIL] the notes",
    latency_ms: 12.5,
    detectors: { pii: "presidio(en_core_web_lg)+contextual-phone", injection: "rules-v1" },
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (call: Call) => Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function expectFailure(outcome: AnalyzeOutcome) {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.error.message, FAIL_CLOSED_MESSAGE);
  return outcome.error;
}

test("sends a correctly formed POST to /api/v1/analyze", async () => {
  const { fetch, calls } = fakeFetch(() => json(200, backendResponse()));
  const client = new ApiClient({ baseUrl: "http://backend.test/", fetchImpl: fetch });
  await client.analyze({ prompt: "Email a@b.co the notes", site: "chatgpt" });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "http://backend.test/api/v1/analyze");
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.credentials, "omit");
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    prompt: "Email a@b.co the notes",
    site: "chatgpt",
  });
});

test("returns the backend decision unchanged on success", async () => {
  const body = backendResponse({ decision: "BLOCK", risk_level: "high", risk_score: 100 });
  const { fetch } = fakeFetch(() => json(200, body));
  const outcome = await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({
    prompt: "x",
    site: "chatgpt",
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.response, body);
});

test("503 from the backend fails closed with retryable from the body", async () => {
  const { fetch } = fakeFetch(() =>
    json(503, { error: "analysis_unavailable", message: FAIL_CLOSED_MESSAGE, retryable: true }),
  );
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "x", site: "chatgpt" }),
  );
  assert.equal(error.kind, "http");
  assert.equal(error.status, 503);
  assert.equal(error.retryable, true);
  assert.ok(error.detail.includes("analysis_unavailable"));
});

test("413 is reported as non-retryable", async () => {
  const { fetch } = fakeFetch(() =>
    json(413, { error: "prompt_too_long", message: "too long", retryable: false }),
  );
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "x", site: "chatgpt" }),
  );
  assert.equal(error.status, 413);
  assert.equal(error.retryable, false);
});

test("network error fails closed", async () => {
  const { fetch } = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "x", site: "chatgpt" }),
  );
  assert.equal(error.kind, "network");
  assert.equal(error.retryable, true);
});

test("timeout aborts the request and fails closed", async () => {
  const { fetch } = fakeFetch(
    ({ init }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch, timeoutMs: 20 }).analyze({
      prompt: "x",
      site: "chatgpt",
    }),
  );
  assert.equal(error.kind, "timeout");
});

test("200 with a malformed body fails closed instead of guessing a decision", async () => {
  const cases: unknown[] = [
    { decision: "ALLOW" },
    backendResponse({ decision: "MAYBE" as never }),
    backendResponse({ risk_score: 150 }),
    { ...backendResponse(), pii_summary: { EMAIL_ADDRESS: "1" } },
    null,
  ];
  for (const body of cases) {
    const { fetch } = fakeFetch(() => json(200, body));
    const error = expectFailure(
      await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "x", site: "chatgpt" }),
    );
    assert.equal(error.kind, "invalid_response");
  }
});

test("200 with non-JSON body fails closed", async () => {
  const { fetch } = fakeFetch(() => Promise.resolve(new Response("<html>", { status: 200 })));
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "x", site: "chatgpt" }),
  );
  assert.equal(error.kind, "invalid_response");
});

test("empty prompt is rejected without calling the backend", async () => {
  const { fetch, calls } = fakeFetch(() => json(200, backendResponse()));
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: "", site: "chatgpt" }),
  );
  assert.equal(error.kind, "invalid_request");
  assert.equal(calls.length, 0);
});

test("failure details never contain the prompt", async () => {
  const secret = "my card is 4111 1111 1111 1111";
  const { fetch } = fakeFetch(() => Promise.reject(new Error(secret)));
  const error = expectFailure(
    await new ApiClient({ baseUrl: "http://b", fetchImpl: fetch }).analyze({ prompt: secret, site: "chatgpt" }),
  );
  assert.ok(!JSON.stringify(error).includes("4111"));
});

test("isAnalyzeResponse accepts a real-shaped response and null sanitized_prompt", () => {
  assert.ok(isAnalyzeResponse(backendResponse()));
  assert.ok(isAnalyzeResponse(backendResponse({ sanitized_prompt: null, pii_entities: [], pii_summary: {} })));
});
