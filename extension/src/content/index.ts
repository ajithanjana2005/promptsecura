/**
 * PromptSecura content script entry point.
 *
 * Injected on supported AI sites (see manifest.json content_scripts). It
 * selects the site adapter for the current page and, in later phases, will
 * wire adapter submit events -> service worker analysis -> on-page UI.
 *
 * Phase 3 status: adapter selection only. No prompt is read, no DOM is
 * modified, and no submit is intercepted.
 */

import { log } from "../shared/log";
import type { SiteAdapter } from "./sites/adapter";
import { findAdapter } from "./sites/adapter";
import { ChatGPTAdapter } from "./sites/chatgpt";

/** Registered adapters. Add new sites here. */
const ADAPTERS: readonly SiteAdapter[] = [new ChatGPTAdapter()];

const INSTANCE_FLAG = "__promptsecuraContentScriptLoaded";

function main(): void {
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  if (scope[INSTANCE_FLAG]) return; // guard against double injection
  scope[INSTANCE_FLAG] = true;

  const adapter = findAdapter(new URL(window.location.href), ADAPTERS);
  if (!adapter) {
    log.debug("no adapter for this page");
    return;
  }

  log.debug(`adapter selected: ${adapter.id}`, adapter.capabilities);

  if (!adapter.capabilities.interceptSubmit) {
    log.info(
      `${adapter.displayName}: prompt interception is not implemented in this build; ` +
        "prompts on this site are not being checked.",
    );
    return;
  }

  // Later phase: adapter.onSubmitAttempt(...) -> chrome.runtime.sendMessage(
  //   { type: MessageType.Analyze, payload: { prompt, site: adapter.id } }) -> UI.
}

main();
