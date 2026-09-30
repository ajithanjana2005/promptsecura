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
 * Privacy: prompt text goes only to the service worker (and from there to the
 * configured PromptSecura backend). It is never logged. The only prompt text
 * shown on the page is the backend's sanitized prompt (PII replaced).
 */

import {
  EDITOR_POLL_MS,
  PASTE_DEBOUNCE_MS,
  TYPING_DEBOUNCE_MS,
} from "../shared/config";
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

  // Poll: catches changes without input events (editor cleared after Send,
  // new chat, restored drafts) and keeps the indicator next to the composer.
  setInterval(() => {
    controller.onTextChanged(adapter.getPromptText(), "poll");
    reposition();
  }, EDITOR_POLL_MS);

  window.addEventListener("resize", reposition, { passive: true });
  window.addEventListener("scroll", reposition, { passive: true, capture: true });

  controller.onTextChanged(adapter.getPromptText(), "init");

  if (!adapter.capabilities.interceptSubmit || !adapter.capabilities.writePrompt) {
    log.info(`${adapter.displayName}: read-only analysis active; sending is not enforced.`);
    return;
  }

  // Enforcement: every submit attempt goes through the guard.
  const panel = new EnforcementPanel(document, () => adapter.getIndicatorAnchor());
  const guard = new SubmitGuard({
    analyze: (text) => controller.analyzeNow(text),
    editor: adapter,
    ui: panel,
  });
  adapter.onSubmitAttempt((source) => {
    void guard.handleSubmitAttempt().then((result) => {
      log.debug("submit attempt", { source, result }); // metadata only, never text
    });
  });
  log.info(
    `${adapter.displayName}: protection active. Prompts are checked before sending; ` +
      "risky prompts are sanitized or blocked.",
  );
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
