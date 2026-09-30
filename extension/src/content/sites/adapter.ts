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

/**
 * Reported by observeComposer() whenever the page may have changed: the
 * composer appeared, disappeared or was replaced, its content changed, or
 * the SPA navigated to another URL.
 */
export interface ComposerChange {
  /** The page URL changed since the last report (SPA navigation). */
  navigated: boolean;
  /** The editor element is a different element (or appeared/disappeared). */
  editorChanged: boolean;
  /** Whether a prompt editor is currently on the page. */
  hasEditor: boolean;
}

/** How the user tried to submit. */
export type SubmitSource = "enter" | "button" | "form";

/**
 * Called when the user tries to submit. By the time it is called the
 * adapter has ALREADY cancelled the site's submission; the only way the
 * prompt is sent afterwards is an explicit `submitApproved(text)` call.
 */
export type SubmitHandler = (source: SubmitSource) => void;

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

  /**
   * Replace the prompt text and verify the editor now holds it. Returns
   * false if not supported, no editor is present, or the write did not take.
   */
  setPromptText(text: string): boolean;

  /** Put keyboard focus in the prompt editor (e.g. for "Edit Prompt"). */
  focusEditor(): void;

  /**
   * True while the site itself would not accept a new prompt (e.g. a reply is
   * still being generated). Submit attempts are then ignored, as the site
   * itself would ignore them.
   */
  isSiteBusy(): boolean;

  /**
   * Watch the page for composer/navigation changes (SPA). Must be
   * lightweight: coalesced, and must not react to PromptSecura's own UI.
   */
  observeComposer(listener: (change: ComposerChange) => void): Unsubscribe;

  /**
   * Intercept every submit attempt (Enter, send button, form submit): the
   * site's own submission is cancelled and `handler` is called instead.
   * Adapters without the interceptSubmit capability must not register
   * anything and return a no-op.
   */
  onSubmitAttempt(handler: SubmitHandler): Unsubscribe;

  /**
   * Submit through the site's own send mechanism, but ONLY if the editor
   * currently contains exactly `approvedText`. Returns false (and sends
   * nothing) otherwise, or if no send control could be found.
   */
  submitApproved(approvedText: string): boolean;
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
