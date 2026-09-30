/**
 * Site adapter interface.
 *
 * Everything site-specific (DOM selectors, how to read/write the prompt
 * editor, how a submit is triggered) lives behind this interface, so the
 * content script, UI and service worker stay site-agnostic and new sites are
 * added as new adapter files.
 *
 * Adapters declare what they can actually do via `capabilities`. The content
 * script must check a capability before relying on it.
 */

import type { SiteId } from "../../shared/types";

export interface AdapterCapabilities {
  /** Can locate the prompt input and read its current text. */
  readPrompt: boolean;
  /** Can report typing/paste in the prompt input (passively, without blocking anything). */
  observeInput: boolean;
  /** Can replace the prompt text (e.g. with the sanitized prompt). */
  writePrompt: boolean;
  /** Can intercept a submit attempt (Enter key / send button) before it happens. */
  interceptSubmit: boolean;
}

/** Why the prompt text may have changed. */
export type InputReason = "input" | "paste";

/** Called when the user tries to submit. Return true to let the submit proceed. */
export type SubmitHandler = (promptText: string) => Promise<boolean>;

/** Stops a previously registered listener. */
export type Unsubscribe = () => void;

export interface SiteAdapter {
  readonly id: SiteId;
  readonly displayName: string;
  readonly capabilities: Readonly<AdapterCapabilities>;

  /** True if this adapter handles the given page URL. */
  matches(url: URL): boolean;

  /** The prompt editor element currently on the page, or null if not found. */
  findEditor(): HTMLElement | null;

  /** Current prompt text, or null if the input is not found / not supported. */
  getPromptText(): string | null;

  /**
   * Element the risk indicator should be positioned next to (e.g. the
   * composer), or null if none is on the page.
   */
  getIndicatorAnchor(): HTMLElement | null;

  /**
   * Notify `listener` when the user types or pastes into the prompt input.
   * Listeners must be passive: they must never cancel, delay or alter the
   * site's own handling of the event. Adapters without the observeInput
   * capability must not register anything and return a no-op.
   */
  observeInput(listener: (reason: InputReason) => void): Unsubscribe;

  /** Replace the prompt text. Returns false if not supported or it failed. */
  setPromptText(text: string): boolean;

  /**
   * Register a handler for submit attempts. Adapters without the
   * interceptSubmit capability must not register anything and return a no-op.
   */
  onSubmitAttempt(handler: SubmitHandler): Unsubscribe;
}

/**
 * Hostname match helper for adapters: exact, case-insensitive host match over
 * HTTPS only. Kept exact so it agrees with content_scripts.matches.
 */
export function hostnameMatches(url: URL, hostnames: readonly string[]): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return hostnames.some((h) => host === h.toLowerCase());
}

export function findAdapter(url: URL, adapters: readonly SiteAdapter[]): SiteAdapter | null {
  return adapters.find((adapter) => adapter.matches(url)) ?? null;
}
