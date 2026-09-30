/**
 * Site adapter interface.
 *
 * Everything site-specific (DOM selectors, how to read/write the prompt
 * editor, how a submit is triggered) lives behind this interface, so the
 * content script, UI and service worker stay site-agnostic and new sites are
 * added as new adapter files.
 *
 * Adapters declare what they can actually do via `capabilities`. The content
 * script must check a capability before relying on it. A placeholder
 * adapter reports every capability as false.
 */

import type { SiteId } from "../../shared/types";

export interface AdapterCapabilities {
  /** Can locate the prompt input and read its current text. */
  readPrompt: boolean;
  /** Can replace the prompt text (e.g. with the sanitized prompt). */
  writePrompt: boolean;
  /** Can intercept a submit attempt (Enter key / send button) before it happens. */
  interceptSubmit: boolean;
}

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

  /** Current prompt text, or null if the input is not found / not supported. */
  getPromptText(): string | null;

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
