/**
 * Indicator states and the mapping from a backend outcome to a state.
 *
 * DOM-free so it can be unit-tested. The mapping follows the backend's
 * DECISION (not just its risk level), because the decision is what the
 * enforcement phase will act on:
 *
 *   ALLOW    -> Safe
 *   SANITIZE -> Medium Risk
 *   BLOCK    -> High Risk   (includes medium scores escalated to BLOCK)
 *   failure  -> Backend Unavailable (fail-closed: never shown as Safe)
 */

import type { AnalyzeOutcome, Decision } from "../shared/types";

export type IndicatorState =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | {
      kind: "safe" | "medium" | "high";
      decision: Decision;
      riskScore: number;
      reasons: readonly string[];
    }
  | { kind: "unavailable"; label: string; detail: string };

export const LABELS = {
  analyzing: "Analyzing…",
  safe: "Safe",
  medium: "Medium Risk",
  high: "High Risk",
  unavailable: "Backend Unavailable",
  tooLong: "Too Long to Analyze",
} as const;

const KIND_BY_DECISION: Record<Decision, "safe" | "medium" | "high"> = {
  ALLOW: "safe",
  SANITIZE: "medium",
  BLOCK: "high",
};

export function stateFromOutcome(outcome: AnalyzeOutcome): IndicatorState {
  if (outcome.ok) {
    const r = outcome.response;
    return {
      kind: KIND_BY_DECISION[r.decision],
      decision: r.decision,
      riskScore: r.risk_score,
      reasons: r.reasons,
    };
  }
  const e = outcome.error;
  // 413 means the backend is up but refused the input; say so accurately.
  const label = e.kind === "http" && e.status === 413 ? LABELS.tooLong : LABELS.unavailable;
  return { kind: "unavailable", label, detail: `${e.message} (${e.detail})` };
}

export function labelFor(state: IndicatorState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "analyzing":
      return LABELS.analyzing;
    case "safe":
      return LABELS.safe;
    case "medium":
      return LABELS.medium;
    case "high":
      return LABELS.high;
    case "unavailable":
      return state.label;
  }
}

/** Tooltip text. Contains no prompt text: backend reasons name types/rules only. */
export function tooltipFor(state: IndicatorState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "analyzing":
      return "PromptSecura is checking this prompt.";
    case "safe":
    case "medium":
    case "high": {
      const lines = [`PromptSecura: ${labelFor(state)} (risk ${state.riskScore}/100)`];
      for (const reason of state.reasons) lines.push(`• ${reason}`);
      lines.push("Read-only: sending is not blocked in this version.");
      return lines.join("\n");
    }
    case "unavailable":
      return `PromptSecura: ${state.detail}\nThis prompt has not been checked.`;
  }
}

export function sameState(a: IndicatorState, b: IndicatorState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
