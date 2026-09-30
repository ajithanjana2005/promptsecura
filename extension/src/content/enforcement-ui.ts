/**
 * Enforcement panel (Phase 5): the SANITIZE / BLOCKED / ERROR dialogs and the
 * brief "SANITIZED" confirmation.
 *
 * Same approach as the risk indicator: its own Shadow DOM on a host appended
 * to <html>, outside the site's React tree, positioned with fixed
 * coordinates above the composer. All text is set with textContent (never
 * innerHTML), and the panel shows no prompt text other than the backend's
 * sanitized prompt, which has PII replaced by placeholders.
 */

import type { AnalyzeResponse } from "../shared/types";
import { describeFindings } from "./findings";
import type {
  BlockChoice,
  EnforcementUI,
  ErrorChoice,
  GuardError,
  SanitizeChoice,
} from "./submit-guard";

export const PANEL_HOST_ID = "promptsecura-enforcement-host";
const GAP_PX = 8;
const TOAST_MS = 2500;

type Variant = "sanitize" | "blocked" | "error" | "sanitized";

const BADGES: Record<Variant, string> = {
  sanitize: "SANITIZE",
  blocked: "BLOCKED",
  error: "ERROR",
  sanitized: "SANITIZED",
};

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed;
  z-index: 2147483001;
  box-sizing: border-box;
  width: min(560px, calc(100vw - 16px));
  max-height: min(60vh, 520px);
  overflow: auto;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1a1d24;
  background: #ffffff;
  border: 1px solid #d9dde3;
  border-top: 4px solid var(--accent);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}
.panel[hidden] { display: none; }
.panel.dark { color: #eceef2; background: #22252b; border-color: #3a3f48; border-top-color: var(--accent); }
.sanitize { --accent: #d97706; }
.blocked { --accent: #dc2626; }
.error { --accent: #6b7280; }
.sanitized { --accent: #16a34a; }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px 14px; }
.brand { font-weight: 600; font-size: 12px; opacity: 0.75; }
.badge {
  font-weight: 700; font-size: 10.5px; letter-spacing: 0.06em;
  color: #fff; background: var(--accent); border-radius: 999px; padding: 2px 8px;
}
.close {
  margin-left: auto; border: 0; background: transparent; color: inherit;
  font-size: 18px; line-height: 1; cursor: pointer; opacity: 0.6; padding: 2px 6px;
}
.close:hover { opacity: 1; }
.body { padding: 0 14px 12px; }
h2 { margin: 2px 0 4px; font-size: 15px; }
.risk { margin: 0 0 8px; font-weight: 600; color: var(--accent); }
.section { margin: 8px 0 0; }
.section h3 { margin: 0 0 3px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
ul { margin: 0; padding-left: 18px; }
li { margin: 1px 0; }
pre {
  margin: 0; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(127, 127, 127, 0.1); border-radius: 8px; max-height: 160px; overflow: auto;
}
.note { margin: 10px 0 0; font-size: 12px; opacity: 0.8; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button.action {
  font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 8px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid #c9ced6; background: transparent; color: inherit;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.action:focus-visible, .close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

interface Action<C extends string> {
  label: string;
  choice: C;
  primary?: boolean;
  id: string;
}

export class EnforcementPanel implements EnforcementUI {
  private readonly doc: Document;
  private readonly getAnchor: () => HTMLElement | null;
  private host: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  /** Resolves the open dialog with its "dismiss" choice. */
  private dismissOpen: (() => void) | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document, getAnchor: () => HTMLElement | null) {
    this.doc = doc;
    this.getAnchor = getAnchor;
  }

  showSanitize(response: AnalyzeResponse): Promise<SanitizeChoice> {
    const f = describeFindings(response);
    return this.open<SanitizeChoice>("sanitize", "cancel", (body) => {
      this.heading(body, "Sensitive information detected", f.riskLine);
      this.list(body, "Detected", [...f.sensitiveData, ...f.threats]);
      this.pre(body, "Sanitized prompt", response.sanitized_prompt ?? "");
      this.note(body, "Your original prompt was not sent.");
    }, [
      { label: "Use Sanitized Prompt", choice: "use-sanitized", primary: true, id: "use-sanitized" },
      { label: "Edit Prompt", choice: "edit", id: "edit" },
      { label: "Cancel", choice: "cancel", id: "cancel" },
    ]);
  }

  showBlocked(response: AnalyzeResponse): Promise<BlockChoice> {
    const f = describeFindings(response);
    const threats = [...f.threats, ...f.sensitiveData];
    return this.open<BlockChoice>("blocked", "close", (body) => {
      this.heading(body, "Prompt blocked", f.riskLine);
      this.list(body, "Detected threats", threats.length ? threats : [...response.reasons]);
      this.note(body, "This prompt was not sent to ChatGPT. Edit it and send again to retry.");
    }, [{ label: "Edit Prompt", choice: "edit", primary: true, id: "edit" }]);
  }

  showError(error: GuardError): Promise<ErrorChoice> {
    const actions: Action<ErrorChoice>[] = [];
    if (error.retryable) actions.push({ label: "Retry", choice: "retry", primary: true, id: "retry" });
    actions.push({ label: "Edit Prompt", choice: "edit", primary: !error.retryable, id: "edit" });
    return this.open<ErrorChoice>("error", "close", (body) => {
      this.heading(body, error.title, null);
      const detail = this.doc.createElement("p");
      detail.className = "detail";
      detail.textContent = error.detail;
      body.append(detail);
      this.note(body, "Nothing was sent.");
    }, actions);
  }

  notifySanitizedSent(): void {
    this.render("sanitized", (body) => {
      this.heading(body, "Sanitized prompt sent", null);
    }, []);
    this.toastTimer = setTimeout(() => this.hide(), TOAST_MS);
  }

  /** Close any open dialog (resolving it as dismissed) and hide the panel. */
  dismiss(): void {
    this.dismissOpen?.();
    this.hide();
  }

  // --- internals -------------------------------------------------------------

  private open<C extends string>(
    variant: Variant,
    dismissChoice: C,
    fill: (body: HTMLElement) => void,
    actions: Action<C>[],
  ): Promise<C> {
    this.dismissOpen?.(); // only one dialog at a time
    return new Promise<C>((resolve) => {
      let settled = false;
      const settle = (choice: C): void => {
        if (settled) return;
        settled = true;
        this.dismissOpen = null;
        this.hide();
        resolve(choice);
      };
      this.dismissOpen = () => settle(dismissChoice);
      this.render(variant, fill, actions.map((a) => ({ ...a, onClick: () => settle(a.choice) })), () =>
        settle(dismissChoice),
      );
    });
  }

  private render(
    variant: Variant,
    fill: (body: HTMLElement) => void,
    actions: (Action<string> & { onClick: () => void })[],
    onClose?: () => void,
  ): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.ensureMounted();
    const panel = this.panel!;
    panel.replaceChildren();
    panel.className = `panel ${variant}${this.isDarkTheme() ? " dark" : ""}`;
    panel.dataset["variant"] = variant;
    panel.setAttribute("role", variant === "sanitized" ? "status" : "dialog");
    panel.setAttribute("aria-label", `PromptSecura: ${BADGES[variant]}`);

    const header = this.doc.createElement("header");
    const brand = this.doc.createElement("span");
    brand.className = "brand";
    brand.textContent = "PromptSecura";
    const badge = this.doc.createElement("span");
    badge.className = "badge";
    badge.textContent = BADGES[variant];
    header.append(brand, badge);
    if (onClose) {
      const close = this.doc.createElement("button");
      close.className = "close";
      close.id = "close";
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.textContent = "×";
      close.addEventListener("click", onClose);
      header.append(close);
    }

    const body = this.doc.createElement("div");
    body.className = "body";
    fill(body);

    if (actions.length) {
      const row = this.doc.createElement("div");
      row.className = "actions";
      for (const action of actions) {
        const button = this.doc.createElement("button");
        button.type = "button";
        button.id = action.id;
        button.className = `action${action.primary ? " primary" : ""}`;
        button.textContent = action.label;
        button.addEventListener("click", action.onClick);
        row.append(button);
      }
      body.append(row);
    }

    panel.append(header, body);
    panel.onkeydown = onClose
      ? (event: KeyboardEvent) => {
          if (event.key === "Escape") onClose();
        }
      : null;
    panel.hidden = false;
    this.position();
    const primary = panel.querySelector<HTMLButtonElement>("button.primary");
    primary?.focus();
  }

  private heading(body: HTMLElement, title: string, riskLine: string | null): void {
    const h = this.doc.createElement("h2");
    h.textContent = title;
    body.append(h);
    if (riskLine) {
      const risk = this.doc.createElement("p");
      risk.className = "risk";
      risk.textContent = riskLine;
      body.append(risk);
    }
  }

  private list(body: HTMLElement, title: string, items: string[]): void {
    if (!items.length) return;
    const section = this.doc.createElement("div");
    section.className = "section";
    const h = this.doc.createElement("h3");
    h.textContent = title;
    const ul = this.doc.createElement("ul");
    for (const item of items) {
      const li = this.doc.createElement("li");
      li.textContent = item;
      ul.append(li);
    }
    section.append(h, ul);
    body.append(section);
  }

  private pre(body: HTMLElement, title: string, text: string): void {
    const section = this.doc.createElement("div");
    section.className = "section";
    const h = this.doc.createElement("h3");
    h.textContent = title;
    const pre = this.doc.createElement("pre");
    pre.className = "sanitized-prompt";
    pre.textContent = text;
    section.append(h, pre);
    body.append(section);
  }

  private note(body: HTMLElement, text: string): void {
    const p = this.doc.createElement("p");
    p.className = "note";
    p.textContent = text;
    body.append(p);
  }

  private ensureMounted(): void {
    if (this.host?.isConnected) return;
    const host = this.doc.createElement("div");
    host.id = PANEL_HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = STYLE;
    const panel = this.doc.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    root.append(style, panel);
    this.doc.documentElement.append(host);
    this.host = host;
    this.panel = panel;
  }

  /** Above the composer, left-aligned with it; bottom of the viewport if none. */
  private position(): void {
    const panel = this.panel;
    if (!panel) return;
    const viewport = this.doc.documentElement;
    const rect = this.getAnchor()?.getBoundingClientRect();
    const width = panel.offsetWidth;
    if (rect && rect.width > 0) {
      const left = Math.max(GAP_PX, Math.min(rect.left, viewport.clientWidth - width - GAP_PX));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.bottom = `${Math.round(Math.max(GAP_PX, viewport.clientHeight - rect.top + GAP_PX))}px`;
    } else {
      panel.style.left = `${Math.round(Math.max(GAP_PX, (viewport.clientWidth - width) / 2))}px`;
      panel.style.bottom = `${GAP_PX * 3}px`;
    }
    panel.style.top = "auto";
  }

  private hide(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.panel) {
      this.panel.hidden = true;
      this.panel.replaceChildren();
    }
  }

  private isDarkTheme(): boolean {
    const html = this.doc.documentElement;
    if (html.classList.contains("dark")) return true;
    if (html.classList.contains("light")) return false;
    return this.doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }
}
