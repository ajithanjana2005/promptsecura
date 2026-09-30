/**
 * Shared types for the PromptSecura extension.
 *
 * The API types mirror the backend's Pydantic schemas in
 * backend/app/schemas/analysis.py. Keep them in sync when the API changes.
 */

// ---------------------------------------------------------------------------
// Backend API contract
// ---------------------------------------------------------------------------

/** Sites the backend accepts. Gemini/Claude will be added in later phases. */
export type SiteId = "chatgpt";

export type Decision = "ALLOW" | "SANITIZE" | "BLOCK";

export type RiskLevel = "low" | "medium" | "high";

export interface AnalyzeRequest {
  prompt: string;
  site: SiteId;
}

export interface PIIEntity {
  entity_type: string;
  /** Offset into the backend-normalized prompt, not the raw input. */
  start: number;
  end: number;
  score: number;
  placeholder: string;
  source: string;
}

export interface InjectionMatch {
  rule_id: string;
  category: string;
  description: string;
  weight: number;
}

export interface ScoreBreakdown {
  pii: number;
  injection: number;
  obfuscation: number;
  total: number;
}

export interface AnalyzeResponse {
  request_id: string;
  decision: Decision;
  risk_level: RiskLevel;
  risk_score: number;
  reasons: string[];
  pii_entities: PIIEntity[];
  pii_summary: Record<string, number>;
  injection_matches: InjectionMatch[];
  score_breakdown: ScoreBreakdown;
  /**
   * PII replaced by placeholders; null when no PII was found. Only a
   * SANITIZE decision means it is safe to send as-is.
   */
  sanitized_prompt: string | null;
  latency_ms: number;
  detectors: Record<string, string>;
}

/** Body of backend 413/503/500 responses. */
export interface ApiErrorBody {
  error: string;
  message: string;
  retryable: boolean;
}

export type ComponentState = "ready" | "unavailable" | "not_loaded";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  components: Record<string, ComponentState>;
  details: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Extension-internal results and messages
// ---------------------------------------------------------------------------

export type AnalysisFailureKind =
  | "network" // backend unreachable
  | "timeout" // no response within the configured timeout
  | "http" // non-2xx from the backend (e.g. 503 fail-closed)
  | "invalid_response" // 2xx but the body does not match AnalyzeResponse
  | "invalid_request"; // rejected before sending (e.g. empty prompt)

/**
 * Any failure means NO security decision was made. Callers must never treat
 * a failure as ALLOW (fail-closed policy).
 */
export interface AnalysisFailure {
  kind: AnalysisFailureKind;
  /** User-facing message. */
  message: string;
  /** Diagnostic detail. Never contains prompt text. */
  detail: string;
  /** HTTP status for kind === "http", otherwise null. */
  status: number | null;
  retryable: boolean;
}

export type AnalyzeOutcome =
  | { ok: true; response: AnalyzeResponse }
  | { ok: false; error: AnalysisFailure };

export const MessageType = {
  Analyze: "promptsecura/analyze",
} as const;

export interface AnalyzeMessage {
  type: typeof MessageType.Analyze;
  payload: AnalyzeRequest;
}

/** Union of all messages the service worker accepts. */
export type ExtensionMessage = AnalyzeMessage;
