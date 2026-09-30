/**
 * Backend API client for POST /api/v1/analyze.
 *
 * Runs in the service worker, which has host_permissions for the backend
 * origin. No chrome.* APIs are used here, so it can be unit-tested with an
 * injected fetch.
 *
 * Fail-closed contract: analyze() never throws and never returns a
 * decision it did not receive from the backend. Every problem (network,
 * timeout, non-2xx, malformed body) becomes { ok: false } with the standard
 * FAIL_CLOSED_MESSAGE.
 */

import { API_PATHS, FAIL_CLOSED_MESSAGE, REQUEST_TIMEOUT_MS } from "../shared/config";
import type {
  AnalysisFailure,
  AnalysisFailureKind,
  AnalyzeOutcome,
  AnalyzeRequest,
  AnalyzeResponse,
} from "../shared/types";

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DECISIONS = new Set(["ALLOW", "SANITIZE", "BLOCK"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);

function failure(
  kind: AnalysisFailureKind,
  detail: string,
  status: number | null = null,
  retryable = true,
): AnalyzeOutcome {
  const error: AnalysisFailure = { kind, message: FAIL_CLOSED_MESSAGE, detail, status, retryable };
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecordOf<T>(value: unknown, check: (v: unknown) => v is T): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

/** Runtime check that a backend body matches AnalyzeResponse. */
export function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  if (!isRecord(value)) return false;
  const v = value;
  const breakdown = v["score_breakdown"];
  return (
    isString(v["request_id"]) &&
    isString(v["decision"]) &&
    DECISIONS.has(v["decision"]) &&
    isString(v["risk_level"]) &&
    RISK_LEVELS.has(v["risk_level"]) &&
    isNumber(v["risk_score"]) &&
    v["risk_score"] >= 0 &&
    v["risk_score"] <= 100 &&
    Array.isArray(v["reasons"]) &&
    v["reasons"].every(isString) &&
    Array.isArray(v["pii_entities"]) &&
    v["pii_entities"].every(
      (e) =>
        isRecord(e) &&
        isString(e["entity_type"]) &&
        isNumber(e["start"]) &&
        isNumber(e["end"]) &&
        isNumber(e["score"]) &&
        isString(e["placeholder"]) &&
        isString(e["source"]),
    ) &&
    isRecordOf(v["pii_summary"], isNumber) &&
    Array.isArray(v["injection_matches"]) &&
    v["injection_matches"].every(
      (m) =>
        isRecord(m) &&
        isString(m["rule_id"]) &&
        isString(m["category"]) &&
        isString(m["description"]) &&
        isNumber(m["weight"]),
    ) &&
    isRecord(breakdown) &&
    isNumber(breakdown["pii"]) &&
    isNumber(breakdown["injection"]) &&
    isNumber(breakdown["obfuscation"]) &&
    isNumber(breakdown["total"]) &&
    (v["sanitized_prompt"] === null || isString(v["sanitized_prompt"])) &&
    isNumber(v["latency_ms"]) &&
    isRecordOf(v["detectors"], isString)
  );
}

function errorCode(body: unknown): string {
  return isRecord(body) && isString(body["error"]) ? body["error"] : "unknown_error";
}

function isRetryable(status: number, body: unknown): boolean {
  if (isRecord(body) && typeof body["retryable"] === "boolean") return body["retryable"];
  return status >= 500;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    if (typeof request.prompt !== "string" || request.prompt.length === 0) {
      return failure("invalid_request", "Prompt must be a non-empty string", null, false);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + API_PATHS.analyze, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: request.prompt, site: request.site }),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        return failure("timeout", `No response within ${this.timeoutMs} ms`);
      }
      return failure("network", err instanceof Error ? err.name : "Network request failed");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return failure("timeout", `No response within ${this.timeoutMs} ms`);
      }
      body = undefined;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return failure(
        "http",
        `HTTP ${response.status}: ${errorCode(body)}`,
        response.status,
        isRetryable(response.status, body),
      );
    }

    if (!isAnalyzeResponse(body)) {
      return failure("invalid_response", "Backend response did not match the expected schema");
    }

    return { ok: true, response: body };
  }
}
