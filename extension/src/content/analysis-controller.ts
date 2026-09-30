/**
 * Decides WHEN to analyze the prompt and WHICH result to show.
 *
 *  - Debounces typing (TYPING_DEBOUNCE_MS) and pastes (PASTE_DEBOUNCE_MS).
 *  - Sends only the latest text; a response for text that has since changed
 *    is discarded (sequence numbers), so the indicator never shows a verdict
 *    for text that is no longer in the editor.
 *  - Unchanged text is not re-sent. The result for the most recently analyzed
 *    text is reused if the user returns to exactly that text.
 *  - Empty/whitespace-only text shows nothing and sends nothing.
 *  - analyze() failures (including thrown errors) become "unavailable";
 *    nothing here can produce "safe" without a backend ALLOW.
 *
 * DOM-free and timer-injectable, so it is unit-tested with fake timers.
 */

import { FAIL_CLOSED_MESSAGE } from "../shared/config";
import type { AnalyzeOutcome } from "../shared/types";
import type { InputReason } from "./sites/adapter";
import { type IndicatorState, sameState, stateFromOutcome } from "./indicator-state";

export type ChangeReason = InputReason | "poll" | "init";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ControllerOptions {
  analyze(text: string): Promise<AnalyzeOutcome>;
  render(state: IndicatorState): void;
  typingDebounceMs: number;
  pasteDebounceMs: number;
  timers?: Timers;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AnalysisController {
  private readonly opts: ControllerOptions;
  private readonly timers: Timers;
  private lastSeenText = "";
  private pending: unknown = null;
  private sequence = 0;
  private lastResult: { text: string; state: IndicatorState } | null = null;
  private current: IndicatorState = { kind: "idle" };
  private disposed = false;

  constructor(options: ControllerOptions) {
    this.opts = options;
    this.timers = options.timers ?? defaultTimers;
  }

  get state(): IndicatorState {
    return this.current;
  }

  /** Report the editor's current text. `null` means no editor on the page. */
  onTextChanged(text: string | null, reason: ChangeReason): void {
    if (this.disposed) return;
    const value = text ?? "";

    if (value === this.lastSeenText) {
      // A paste often also fires an input event with the same text; make sure
      // the shorter paste delay wins if a request is still pending.
      if (reason === "paste" && this.pending !== null) this.schedule(value, this.opts.pasteDebounceMs);
      return;
    }
    this.lastSeenText = value;
    this.cancelPending();

    if (value.trim() === "") {
      this.sequence++; // invalidate any in-flight request
      this.setState({ kind: "idle" });
      return;
    }

    if (this.lastResult && this.lastResult.text === value) {
      this.sequence++;
      this.setState(this.lastResult.state);
      return;
    }

    this.setState({ kind: "analyzing" });
    const delay = reason === "paste" ? this.opts.pasteDebounceMs : this.opts.typingDebounceMs;
    this.schedule(value, delay);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.sequence++;
  }

  private schedule(text: string, delay: number): void {
    this.cancelPending();
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      void this.run(text);
    }, delay);
  }

  private cancelPending(): void {
    if (this.pending !== null) {
      this.timers.clearTimeout(this.pending);
      this.pending = null;
    }
  }

  private async run(text: string): Promise<void> {
    const seq = ++this.sequence;
    let outcome: AnalyzeOutcome;
    try {
      outcome = await this.opts.analyze(text);
    } catch {
      outcome = {
        ok: false,
        error: {
          kind: "network",
          message: FAIL_CLOSED_MESSAGE,
          detail: "Unexpected error",
          status: null,
          retryable: true,
        },
      };
    }
    if (this.disposed || seq !== this.sequence) return; // stale: text changed since
    const state = stateFromOutcome(outcome);
    // Cache only real verdicts; failures should be retried on the next change.
    this.lastResult = state.kind === "unavailable" ? null : { text, state };
    this.setState(state);
  }

  private setState(state: IndicatorState): void {
    if (sameState(state, this.current)) return;
    this.current = state;
    this.opts.render(state);
  }
}
