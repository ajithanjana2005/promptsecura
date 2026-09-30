/**
 * PromptSecura service worker (Manifest V3 background).
 *
 * Responsibilities:
 *   - Own all backend communication. The service worker has host_permissions
 *     for the backend origin; content scripts run in the page's context and
 *     are subject to the page's CORS/CSP rules, so they never call the
 *     backend directly.
 *   - Route messages from extension contexts.
 *
 * Phase 3 status: the "promptsecura/analyze" route and API client are in
 * place, but no content script sends prompts to it yet. Prompt interception
 * on ChatGPT is a later phase.
 */

import { BACKEND_URL, FAIL_CLOSED_MESSAGE, SUPPORTED_SITES } from "../shared/config";
import { log } from "../shared/log";
import type { AnalyzeOutcome, ExtensionMessage } from "../shared/types";
import { MessageType } from "../shared/types";
import { ApiClient } from "./api-client";

const apiClient = new ApiClient({ baseUrl: BACKEND_URL });
const SUPPORTED_SITE_IDS = new Set<string>(SUPPORTED_SITES.map((s) => s.id));

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown; payload?: unknown };
  if (message.type !== MessageType.Analyze) return false;
  const payload = message.payload as { prompt?: unknown; site?: unknown } | null | undefined;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.prompt === "string" &&
    typeof payload.site === "string" &&
    SUPPORTED_SITE_IDS.has(payload.site)
  );
}

async function handleMessage(message: ExtensionMessage): Promise<AnalyzeOutcome> {
  switch (message.type) {
    case MessageType.Analyze: {
      const outcome = await apiClient.analyze(message.payload);
      // Metadata only: never log prompt text or sanitized text.
      if (outcome.ok) {
        log.debug("analysis", {
          request_id: outcome.response.request_id,
          decision: outcome.response.decision,
          risk_score: outcome.response.risk_score,
          latency_ms: outcome.response.latency_ms,
        });
      } else {
        log.warn("analysis failed (fail-closed)", {
          kind: outcome.error.kind,
          status: outcome.error.status,
        });
      }
      return outcome;
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  log.info(`installed (reason: ${details.reason}), backend: ${BACKEND_URL}`);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  if (!isExtensionMessage(message)) {
    const rejected: AnalyzeOutcome = {
      ok: false,
      error: {
        kind: "invalid_request",
        message: FAIL_CLOSED_MESSAGE,
        detail: "Unrecognised or malformed message",
        status: null,
        retryable: false,
      },
    };
    sendResponse(rejected);
    return false;
  }

  handleMessage(message).then(sendResponse, (err: unknown) => {
    // ApiClient never throws; this is a last-resort guard that still fails closed.
    log.error("unexpected error in message handler", err instanceof Error ? err.name : "unknown");
    const failed: AnalyzeOutcome = {
      ok: false,
      error: {
        kind: "network",
        message: FAIL_CLOSED_MESSAGE,
        detail: "Unexpected service worker error",
        status: null,
        retryable: true,
      },
    };
    sendResponse(failed);
  });
  return true; // keep the message channel open for the async response
});
