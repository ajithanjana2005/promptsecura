/**
 * Content script -> service worker bridge for analysis requests.
 *
 * The content script never calls the backend itself; the service worker
 * (which has host_permissions for the backend) does, via the existing
 * ApiClient. Any messaging problem — e.g. "Extension context invalidated"
 * after the extension is reloaded, or a malformed reply — becomes a
 * fail-closed failure, never a verdict.
 */

import { isAnalyzeResponse } from "../background/api-client";
import { FAIL_CLOSED_MESSAGE } from "../shared/config";
import type { AnalysisFailure, AnalyzeMessage, AnalyzeOutcome, SiteId } from "../shared/types";
import { MessageType } from "../shared/types";

function failure(detail: string): AnalyzeOutcome {
  return {
    ok: false,
    error: { kind: "network", message: FAIL_CLOSED_MESSAGE, detail, status: null, retryable: true },
  };
}

function isFailure(value: unknown): value is AnalysisFailure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["kind"] === "string" &&
    typeof v["message"] === "string" &&
    typeof v["detail"] === "string" &&
    (v["status"] === null || typeof v["status"] === "number") &&
    typeof v["retryable"] === "boolean"
  );
}

/** Runtime check of a service-worker reply. */
export function isAnalyzeOutcome(value: unknown): value is AnalyzeOutcome {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["ok"] === true) return isAnalyzeResponse(v["response"]);
  if (v["ok"] === false) return isFailure(v["error"]);
  return false;
}

export type SendMessage = (message: AnalyzeMessage) => Promise<unknown>;

export function createAnalyzer(site: SiteId, sendMessage: SendMessage) {
  return async function analyze(prompt: string): Promise<AnalyzeOutcome> {
    const message: AnalyzeMessage = { type: MessageType.Analyze, payload: { prompt, site } };
    let reply: unknown;
    try {
      reply = await sendMessage(message);
    } catch {
      return failure("Could not reach the PromptSecura service worker (reload the page)");
    }
    return isAnalyzeOutcome(reply) ? reply : failure("Malformed reply from the service worker");
  };
}
