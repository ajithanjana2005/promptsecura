/**
 * The on-page risk indicator.
 *
 * Rendered in its own Shadow DOM, on a host element appended to <html>
 * (outside ChatGPT's React-managed tree), and positioned with fixed
 * coordinates next to the composer. It never inserts anything into the site's
 * DOM tree, so it cannot disturb the site's rendering, styles or Send.
 *
 * It never displays prompt text: only a label, the risk score, and backend
 * reasons (which name entity types/rules, not values) in the tooltip.
 */

import { type IndicatorState, labelFor, tooltipFor } from "./indicator-state";

export const HOST_ID = "promptsecura-indicator-host";
const GAP_PX = 6;

const STYLE = `
:host { all: initial; }
.pill {
  position: fixed;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px 3px 7px;
  border-radius: 999px;
  font: 600 11.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1a1d24;
  background: #ffffff;
  border: 1px solid #d9dde3;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
.pill[hidden] { display: none; }
.pill.dark { color: #eceef2; background: #22252b; border-color: #3a3f48; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa1ad; flex: none; }
.brand { font-weight: 500; opacity: 0.7; }
.score { font-weight: 500; opacity: 0.75; }
.analyzing .dot { background: #9aa1ad; animation: pulse 1s ease-in-out infinite; }
.safe .dot { background: #16a34a; }
.medium .dot { background: #d97706; }
.high .dot { background: #dc2626; }
.unavailable .dot { background: #6b7280; box-shadow: inset 0 0 0 2px #fff; outline: 1px solid #6b7280; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .analyzing .dot { animation: none; } }
`;

export class RiskIndicator {
  private readonly doc: Document;
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private score: HTMLElement | null = null;
  private state: IndicatorState = { kind: "idle" };

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  private ensureMounted(): void {
    if (this.host?.isConnected) return;
    const host = this.doc.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });

    const style = this.doc.createElement("style");
    style.textContent = STYLE;

    const pill = this.doc.createElement("div");
    pill.className = "pill";
    pill.hidden = true;
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");

    const dot = this.doc.createElement("span");
    dot.className = "dot";
    const brand = this.doc.createElement("span");
    brand.className = "brand";
    brand.textContent = "PromptSecura";
    const label = this.doc.createElement("span");
    label.className = "label";
    const score = this.doc.createElement("span");
    score.className = "score";

    pill.append(dot, brand, label, score);
    root.append(style, pill);
    this.doc.documentElement.append(host);

    this.host = host;
    this.pill = pill;
    this.label = label;
    this.score = score;
  }

  render(state: IndicatorState): void {
    this.state = state;
    this.ensureMounted();
    const pill = this.pill!;
    pill.className = `pill ${state.kind}${this.isDarkTheme() ? " dark" : ""}`;
    pill.dataset["state"] = state.kind;
    this.label!.textContent = labelFor(state);
    this.score!.textContent =
      state.kind === "safe" || state.kind === "medium" || state.kind === "high"
        ? `${state.riskScore}/100`
        : "";
    pill.title = tooltipFor(state);
  }

  /** Place the indicator above the anchor's top-right corner (below if no room). */
  position(anchor: HTMLElement | null): void {
    if (!this.pill) return;
    const pill = this.pill;
    const rect = anchor?.getBoundingClientRect();
    if (this.state.kind === "idle" || !rect || rect.width === 0 || rect.height === 0) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    const width = pill.offsetWidth;
    const height = pill.offsetHeight;
    const viewportWidth = this.doc.documentElement.clientWidth;
    let top = rect.top - height - GAP_PX;
    if (top < GAP_PX) top = rect.bottom + GAP_PX;
    const left = Math.max(GAP_PX, Math.min(rect.right - width, viewportWidth - width - GAP_PX));
    pill.style.top = `${Math.round(top)}px`;
    pill.style.left = `${Math.round(left)}px`;
  }

  destroy(): void {
    this.host?.remove();
    this.host = this.pill = this.label = this.score = null;
  }

  private isDarkTheme(): boolean {
    const html = this.doc.documentElement;
    if (html.classList.contains("dark")) return true;
    if (html.classList.contains("light")) return false;
    return this.doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }
}
