/**
 * Human-readable findings for the enforcement panel.
 *
 * Built only from entity TYPES, counts, rule categories/descriptions and the
 * backend's reasons, never from the detected values, so the panel does not
 * echo PII back beyond what the sanitized prompt already shows.
 */

import type { AnalyzeResponse } from "../shared/types";

const ENTITY_NAMES: Record<string, string> = {
  EMAIL_ADDRESS: "Email address",
  PHONE_NUMBER: "Phone number",
  PERSON: "Person name",
  CREDIT_CARD: "Credit card number",
  IP_ADDRESS: "IP address",
  URL: "URL",
};

const CATEGORY_NAMES: Record<string, string> = {
  prompt_injection: "Prompt injection",
  jailbreak: "Jailbreak attempt",
};

export function entityName(type: string): string {
  return ENTITY_NAMES[type] ?? type;
}

export function categoryName(category: string): string {
  return CATEGORY_NAMES[category] ?? category;
}

export interface Findings {
  /** e.g. ["Email address ×1", "Phone number ×1"] */
  sensitiveData: string[];
  /** e.g. ["Prompt injection: Attempts to make the model ignore …"] */
  threats: string[];
  /** e.g. "Risk 70/100 · High" */
  riskLine: string;
}

export function describeFindings(response: AnalyzeResponse): Findings {
  const sensitiveData = Object.entries(response.pii_summary)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${entityName(type)} ×${count}`);
  const threats = response.injection_matches.map(
    (m) => `${categoryName(m.category)}: ${m.description}`,
  );
  const level = response.risk_level.charAt(0).toUpperCase() + response.risk_level.slice(1);
  return { sensitiveData, threats, riskLine: `Risk ${response.risk_score}/100 · ${level}` };
}
