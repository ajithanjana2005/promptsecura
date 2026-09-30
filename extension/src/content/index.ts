/**
 * PromptSecura content script entry point.
 *
 * - Live analysis (Phase 4): observe the prompt editor, analyze its text
 *   through the service worker (debounced), show the risk indicator.
 * - Enforcement (Phase 5): the adapter cancels every submit attempt and hands
 *   it to the SubmitGuard, which re-analyzes the final text immediately
 *   (AnalysisController.analyzeNow) and then sends, offers the sanitized
 *   prompt, blocks, or fails closed.
 *
 * - Real-site handling (Phase 6): the adapter's composer observer (one
 *   coalesced MutationObserver) replaces polling. It re-reads the editor when
 *   the page changes without input events (ChatGPT clearing the box after
 *   Send, a new chat replacing the composer), and on SPA navigation it
 *   invalidates any in-flight submit check and closes its dialog.
 *
 * All listeners are registered exactly once per page (guarded by
 * INSTANCE_FLAG) and are delegated, so they survive composer replacement
 * without re-registration.
 *
 * Privacy: prompt text goes only to the service worker (and from there to the
 * configured PromptSecura backend). It is never logged. The only prompt text
 * shown on the page is the backend's sanitized prompt (PII replaced).
 */

import { PASTE_DEBOUNCE_MS, TYPING_DEBOUNCE_MS } from "../shared/config";
import { log } from "../shared/log";
import { AnalysisController } from "./analysis-controller";
import { EnforcementPanel } from "./enforcement-ui";
import { RiskIndicator } from "./indicator";
import { createAnalyzer } from "./messaging";
import type { SiteAdapter } from "./sites/adapter";
import { findAdapter } from "./sites/adapter";
import { ChatGPTAdapter } from "./sites/chatgpt";
import { SubmitGuard } from "./submit-guard";

/** Registered adapters. Add new sites here. */
const ADAPTERS: readonly SiteAdapter[] = [new ChatGPTAdapter()];

const INSTANCE_FLAG = "__promptsecuraContentScriptLoaded";

function start(adapter: SiteAdapter): void {
  const indicator = new RiskIndicator(document);
  const reposition = (): void => indicator.position(adapter.getIndicatorAnchor());

  const controller = new AnalysisController({
    analyze: createAnalyzer(adapter.id, (message) => chrome.runtime.sendMessage(message)),
    render: (state) => {
      indicator.render(state);
      reposition();
      log.debug("indicator state", state.kind); // state only, never text
    },
    typingDebounceMs: TYPING_DEBOUNCE_MS,
    pasteDebounceMs: PASTE_DEBOUNCE_MS,
  });

  // Typing and paste (passive listeners registered by the adapter).
  adapter.observeInput((reason) => {
    if (reason === "paste") {
      // The pasted text is inserted after the paste event; read it afterwards.
      setTimeout(() => controller.onTextChanged(adapter.getPromptText(), "paste"), 0);
    } else {
      controller.onTextChanged(adapter.getPromptText(), "input");
    }
  });

  window.addEventListener("resize", reposition, { passive: true });
  window.addEventListener("scroll", reposition, { passive: true, capture: true });

  const enforce = adapter.capabilities.interceptSubmit && adapter.capabilities.writePrompt;

  // Enforcement: every submit attempt goes through the guard.
  let guard: SubmitGuard | null = null;
  if (enforce) {
    const panel = new EnforcementPanel(document, () => adapter.getIndicatorAnchor());
    const activeGuard = new SubmitGuard({
      analyze: (text) => controller.analyzeNow(text),
      editor: adapter,
      ui: panel,
    });
    guard = activeGuard;
    adapter.onSubmitAttempt((source) => {
      void activeGuard.handleSubmitAttempt().then((result) => {
        log.debug("submit attempt", { source, result }); // metadata only, never text
      });
    });
  }

  // Dynamic page (SPA): re-read the editor on composer changes; on navigation,
  // drop any in-flight submit check so it can't act on the new page.
  adapter.observeComposer((change) => {
    if (change.navigated) {
      guard?.invalidate();
      log.debug("navigation", { hasEditor: change.hasEditor });
    }
    if (change.editorChanged) log.debug("composer changed", { hasEditor: change.hasEditor });
    log.debug("composer check");
    controller.onTextChanged(adapter.getPromptText(), "poll");
    reposition();
  });

  controller.onTextChanged(adapter.getPromptText(), "init");

  if (enforce) {
    log.info(
      `${adapter.displayName}: protection active. Prompts are checked before sending; ` +
        "risky prompts are sanitized or blocked.",
    );
  } else {
    log.info(`${adapter.displayName}: read-only analysis active; sending is not enforced.`);
  }
}

function main(): void {
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  if (scope[INSTANCE_FLAG]) return; // guard against double injection
  scope[INSTANCE_FLAG] = true;

  const adapter = findAdapter(new URL(window.location.href), ADAPTERS);
  if (!adapter) {
    log.debug("no adapter for this page");
    return;
  }
  if (!adapter.capabilities.readPrompt || !adapter.capabilities.observeInput) {
    log.info(`${adapter.displayName}: prompt analysis is not supported by this adapter.`);
    return;
  }
  start(adapter);
}

main();
