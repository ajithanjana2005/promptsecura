/**
 * Enforcement decisions for a submit attempt (Phase 5).
 *
 * The site adapter has ALREADY cancelled the site's own submission by the
 * time handleSubmitAttempt() runs. The only way anything is sent is
 * editor.submitApproved(text), and this class calls it in exactly two cases:
 *
 *   1. The backend returned ALLOW for exactly the text in the editor.
 *   2. The user chose "Use Sanitized Prompt", the sanitized text was written
 *      into the editor, AND the backend then returned ALLOW for exactly that
 *      written text.
 *
 * Everything else sends nothing: SANITIZE without the user's choice, BLOCK,
 * any analysis failure (fail-closed), unreadable editor, text that changed
 * while it was being checked, or a sanitized write that did not take.
 *
 * Duplicate protection: (1) an in-flight lock ignores repeated Enter presses /
 * clicks while a check or dialog is pending; (2) after a send, an attempt
 * with the identical text within DUPLICATE_WINDOW_MS is ignored, because the
 * site clears its editor asynchronously and a quick second Enter would
 * otherwise resend the same prompt.
 *
 * SPA navigation (Phase 6): invalidate() closes any open dialog and makes an
 * in-flight attempt stale; a stale attempt never sends and releases the lock
 * immediately, so the new page is not blocked by an old check.
 *
 * Site busy (Phase 6): while the site itself would not accept a prompt (a
 * reply is streaming), attempts are ignored without analysis, as the site
 * itself ignores them. Nothing is sent.
 *
 * DOM-free: the editor and UI are injected, so every path is unit-tested.
 */

import { FAIL_CLOSED_MESSAGE } from "../shared/config";
import type { AnalyzeOutcome, AnalyzeResponse } from "../shared/types";

export type SanitizeChoice = "use-sanitized" | "edit" | "cancel";
export type BlockChoice = "edit" | "close";
export type ErrorChoice = "retry" | "edit" | "close";

export interface GuardError {
  title: string;
  detail: string;
  /** Whether "Retry" is offered. */
  retryable: boolean;
}

/** The enforcement dialogs. Each resolves with the user's choice. */
export interface EnforcementUI {
  showSanitize(response: AnalyzeResponse): Promise<SanitizeChoice>;
  showBlocked(response: AnalyzeResponse): Promise<BlockChoice>;
  showError(error: GuardError): Promise<ErrorChoice>;
  /** Brief confirmation after the sanitized prompt was sent. */
  notifySanitizedSent(): void;
  /** Close any open dialog, resolving it as dismissed (no send). */
  dismiss(): void;
}

export interface EditorOps {
  getPromptText(): string | null;
  setPromptText(text: string): boolean;
  focusEditor(): void;
  submitApproved(approvedText: string): boolean;
  /** True while the site would not accept a prompt anyway (e.g. streaming). */
  isSiteBusy?(): boolean;
}

export interface SubmitGuardOptions {
  /** Immediate backend analysis (AnalysisController.analyzeNow). Must not throw. */
  analyze(text: string): Promise<AnalyzeOutcome>;
  editor: EditorOps;
  ui: EnforcementUI;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export const DUPLICATE_WINDOW_MS = 1_500;

/** What happened, for tests and metadata-only logging. */
export type GuardResult =
  | "ignored-busy"
  | "ignored-duplicate"
  | "site-busy"
  | "navigated"
  | "empty"
  | "submitted"
  | "submitted-sanitized"
  | "blocked"
  | "edit"
  | "cancelled"
  | "error-closed"
  | "changed"
  | "submit-failed";

export const MESSAGES = {
  unreadable: "PromptSecura could not read the prompt from the page, so it was not sent.",
  sanitizedWriteFailed:
    "The sanitized prompt could not be inserted into the message box. Nothing was sent; please edit the prompt manually.",
  sanitizedStillRisky:
    "The sanitized prompt still did not pass the check. Nothing was sent; please edit the prompt manually.",
  notSent: "The prompt was not sent.",
  siteNotReady:
    "ChatGPT isn't ready to send right now (for example, a reply is still being generated). Try again in a moment.",
} as const;

export class SubmitGuard {
  private readonly opts: SubmitGuardOptions;
  private readonly now: () => number;
  private busy = false;
  private lastSent: { text: string; at: number } | null = null;
  /** Incremented by invalidate(); attempts from an older epoch are stale. */
  private epoch = 0;

  constructor(options: SubmitGuardOptions) {
    this.opts = options;
    this.now = options.now ?? (() => Date.now());
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * The page changed under us (SPA navigation to another chat): drop any
   * in-flight attempt, close its dialog, and release the lock. The stale
   * attempt can no longer send anything.
   */
  invalidate(): void {
    this.epoch++;
    this.busy = false;
    this.opts.ui.dismiss();
  }

  /** Entry point for every intercepted submit attempt. */
  async handleSubmitAttempt(): Promise<GuardResult> {
    if (this.busy) return "ignored-busy";
    const current = this.opts.editor.getPromptText();
    if (
      this.lastSent !== null &&
      current === this.lastSent.text &&
      this.now() - this.lastSent.at < DUPLICATE_WINDOW_MS
    ) {
      return "ignored-duplicate";
    }
    if (this.opts.editor.isSiteBusy?.()) return "site-busy";
    this.busy = true;
    const epoch = this.epoch;
    try {
      return await this.checkCurrentPrompt(epoch);
    } catch {
      if (epoch !== this.epoch) return "navigated";
      // Defensive: an unexpected error must never turn into a send.
      await this.opts.ui.showError({ title: FAIL_CLOSED_MESSAGE, detail: "Unexpected error", retryable: false });
      return "error-closed";
    } finally {
      // A stale attempt must not release the lock of a newer one.
      if (epoch === this.epoch) this.busy = false;
    }
  }

  private stale(epoch: number): boolean {
    return epoch !== this.epoch;
  }

  private async checkCurrentPrompt(epoch: number): Promise<GuardResult> {
    const text = this.opts.editor.getPromptText();
    if (text === null) {
      return this.error({ title: FAIL_CLOSED_MESSAGE, detail: MESSAGES.unreadable, retryable: true }, epoch);
    }
    if (text.trim() === "") return "empty";
    return this.evaluate(text, false, epoch);
  }

  /** Analyze `text` (the current editor content) and enforce the decision. */
  private async evaluate(text: string, isSanitized: boolean, epoch: number): Promise<GuardResult> {
    const { editor, ui } = this.opts;
    const outcome = await this.opts.analyze(text);
    if (this.stale(epoch)) return "navigated";

    // The verdict only applies to the exact text that was analyzed.
    if (editor.getPromptText() !== text) return "changed";

    if (!outcome.ok) {
      return this.error({ title: FAIL_CLOSED_MESSAGE, detail: outcome.error.detail, retryable: true }, epoch);
    }

    const response = outcome.response;
    switch (response.decision) {
      case "ALLOW":
        return this.submit(text, isSanitized, epoch);

      case "BLOCK": {
        const choice = await ui.showBlocked(response);
        if (this.stale(epoch)) return "navigated";
        if (choice === "edit") editor.focusEditor();
        return "blocked";
      }

      case "SANITIZE": {
        if (isSanitized) {
          // Sanitizing once did not resolve it; never loop or send.
          return this.error({ title: MESSAGES.notSent, detail: MESSAGES.sanitizedStillRisky, retryable: false }, epoch);
        }
        if (response.sanitized_prompt === null) {
          // Nothing to offer; treat as blocked rather than sending the original.
          const choice = await ui.showBlocked(response);
          if (this.stale(epoch)) return "navigated";
          if (choice === "edit") editor.focusEditor();
          return "blocked";
        }
        const choice = await ui.showSanitize(response);
        if (this.stale(epoch)) return "navigated";
        if (choice === "edit") {
          editor.focusEditor();
          return "edit";
        }
        if (choice === "cancel") return "cancelled";

        // "Use Sanitized Prompt": only if the prompt is still the one analyzed.
        if (editor.getPromptText() !== text) return "changed";
        if (!editor.setPromptText(response.sanitized_prompt)) {
          return this.error({ title: MESSAGES.notSent, detail: MESSAGES.sanitizedWriteFailed, retryable: false }, epoch);
        }
        const written = editor.getPromptText();
        if (written === null) {
          return this.error({ title: MESSAGES.notSent, detail: MESSAGES.sanitizedWriteFailed, retryable: false }, epoch);
        }
        // Re-check exactly what is now in the editor before sending it.
        return this.evaluate(written, true, epoch);
      }
    }
  }

  private async submit(text: string, isSanitized: boolean, epoch: number): Promise<GuardResult> {
    if (this.stale(epoch)) return "navigated";
    if (!this.opts.editor.submitApproved(text)) {
      return this.error({ title: MESSAGES.notSent, detail: MESSAGES.siteNotReady, retryable: true }, epoch, "submit-failed");
    }
    this.lastSent = { text, at: this.now() };
    if (isSanitized) this.opts.ui.notifySanitizedSent();
    return isSanitized ? "submitted-sanitized" : "submitted";
  }

  private async error(error: GuardError, epoch: number, result: GuardResult = "error-closed"): Promise<GuardResult> {
    const choice = await this.opts.ui.showError(error);
    if (this.stale(epoch)) return "navigated";
    if (choice === "retry" && error.retryable) return this.checkCurrentPrompt(epoch);
    if (choice === "edit") this.opts.editor.focusEditor();
    return result;
  }
}
