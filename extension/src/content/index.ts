/**
 * PromptSecura content script entry point.
 *
 * Phase 4 (read-only): on a supported site, observe the prompt editor,
 * analyze its text through the service worker (debounced), and show the risk
 * indicator next to the composer.
 *
 * Read-only guarantee: nothing here blocks, delays, alters or intercepts
 * sending. The site's Enter key and send button behave exactly as without
 * the extension. Enforcement is a later phase and requires an adapter with
 * the interceptSubmit capability.
 *
 * Privacy: prompt text goes only to the service worker (and from there to the
 * configured PromptSecura backend). It is never logged or shown on the page.
 */

import {
  EDITOR_POLL_MS,
  PASTE_DEBOUNCE_MS,
  TYPING_DEBOUNCE_MS,
} from "../shared/config";
import { log } from "../shared/log";
import { AnalysisController } from "./analysis-controller";
import { RiskIndicator } from "./indicator";
import { createAnalyzer } from "./messaging";
import type { SiteAdapter } from "./sites/adapter";
import { findAdapter } from "./sites/adapter";
import { ChatGPTAdapter } from "./sites/chatgpt";

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
  log.info(
    `${adapter.displayName}: read-only analysis active. ` +
      "Prompts are checked as you type; sending is not blocked or modified.",
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
