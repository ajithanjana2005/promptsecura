/**
 * ChatGPT site adapter — PLACEHOLDER (Phase 3).
 *
 * This adapter identifies ChatGPT pages but deliberately does NOT touch the
 * DOM: it cannot read the prompt, write the prompt, or intercept submits,
 * and it says so through `capabilities`. The real implementation (locating
 * the prompt editor, reading/writing its text, intercepting Enter and the
 * send button) is a later phase.
 */

import { SUPPORTED_SITES, type SupportedSite } from "../../shared/config";
import type { AdapterCapabilities, SiteAdapter, SubmitHandler, Unsubscribe } from "./adapter";
import { hostnameMatches } from "./adapter";

function chatgptSite(): SupportedSite {
  const site = SUPPORTED_SITES.find((s) => s.id === "chatgpt");
  if (!site) throw new Error("ChatGPT missing from SUPPORTED_SITES");
  return site;
}

const CHATGPT = chatgptSite();

const NO_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  readPrompt: false,
  writePrompt: false,
  interceptSubmit: false,
});

export class ChatGPTAdapter implements SiteAdapter {
  readonly id = CHATGPT.id;
  readonly displayName = CHATGPT.displayName;
  readonly capabilities = NO_CAPABILITIES;

  matches(url: URL): boolean {
    return hostnameMatches(url, CHATGPT.hostnames);
  }

  getPromptText(): string | null {
    return null; // not implemented yet
  }

  setPromptText(_text: string): boolean {
    return false; // not implemented yet
  }

  onSubmitAttempt(_handler: SubmitHandler): Unsubscribe {
    return () => {}; // not implemented yet; registers nothing
  }
}
