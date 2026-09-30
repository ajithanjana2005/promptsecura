/**
 * ChatGPT site adapter (Phase 5: enforcement).
 *
 * Capabilities: read the prompt, observe typing/paste, write the prompt
 * (sanitized text), and intercept submits.
 *
 * Submit interception:
 *   - One set of listeners on `window`, capture phase, so they run before any
 *     of ChatGPT's own handlers (including React's root listeners): Enter
 *     (without Shift, not during IME composition) in the editor, clicks on
 *     the send button, and submit of the composer form. Each is cancelled
 *     with preventDefault() + stopImmediatePropagation(), and the registered
 *     handler decides what happens next.
 *   - The ONLY path to an actual send is submitApproved(text), which checks
 *     that the editor holds exactly `text`, then triggers ChatGPT's own send
 *     button while a synchronous `bypassing` flag is set. The flag is cleared
 *     before submitApproved() returns, so it can let through only the
 *     events of that one programmatic send.
 *
 * Typing/paste observation remains passive (Phase 4).
 *
 * Real-site handling (Phase 6):
 *   - Composer detection: the known editor selectors first; if none match,
 *     any visible editable element inside a known composer <form>. Submit
 *     interception uses the same fallback, so a renamed editor id does not
 *     silently disable enforcement.
 *   - ChatGPT only shows the send button when the box has text (a voice
 *     button otherwise) and shows a stop button while a reply streams.
 *     isSiteBusy() reports the streaming state so attempts are ignored, as
 *     ChatGPT itself ignores them.
 *   - SPA: observeComposer() uses one MutationObserver on <body> (coalesced
 *     to one check per COMPOSER_CHECK_MS, plus a slow fallback timer and
 *     popstate) to report navigation and composer replacement. PromptSecura's
 *     own UI lives on <html>, outside <body>, so it can't trigger the observer.
 *   - Text extraction strips ProseMirror's trailing-break artifacts.
 *
 * DOM assumptions: ChatGPT's composer is a ProseMirror contenteditable with
 * id="prompt-textarea" (older builds used a <textarea> with that id) inside a
 * <form data-type="unified-composer">, with a send button marked
 * data-testid="send-button" and a stop button data-testid="stop-button".
 * These selectors were NOT verified against the live site from the
 * development environment (it was unreachable); if ChatGPT changes its
 * markup, update the *_SELECTORS constants below. All ChatGPT-specific
 * selectors live in this file.
 */

import {
  COMPOSER_CHECK_MS,
  COMPOSER_FALLBACK_CHECK_MS,
  SUPPORTED_SITES,
  type SupportedSite,
} from "../../shared/config";
import type {
  AdapterCapabilities,
  ComposerChange,
  InputReason,
  SiteAdapter,
  SubmitHandler,
  SubmitSource,
  Unsubscribe,
} from "./adapter";
import { hostnameMatches } from "./adapter";

function chatgptSite(): SupportedSite {
  const site = SUPPORTED_SITES.find((s) => s.id === "chatgpt");
  if (!site) throw new Error("ChatGPT missing from SUPPORTED_SITES");
  return site;
}

const CHATGPT = chatgptSite();

/** Tried in order; the first visible match is the editor. */
export const EDITOR_SELECTORS: readonly string[] = [
  '#prompt-textarea[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  "textarea#prompt-textarea",
];

/** Send-button selectors, tried in order (visible elements only). */
export const SEND_BUTTON_SELECTORS: readonly string[] = [
  'button[data-testid="send-button"]',
  "button#composer-submit-button",
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
];

/** The composer form. Used to scope lookups and as the detection fallback. */
export const COMPOSER_FORM_SELECTORS: readonly string[] = [
  'form[data-type="unified-composer"]',
  "form:has(#prompt-textarea)",
];

/** Shown by ChatGPT instead of the send button while a reply is streaming. */
export const STOP_BUTTON_SELECTORS: readonly string[] = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
];

/** Editable elements accepted by the composer-form fallback. */
const EDITABLE_FALLBACK_SELECTOR = '[contenteditable="true"], textarea';

const CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  readPrompt: true,
  observeInput: true,
  writePrompt: true,
  interceptSubmit: true,
});

/** Whitespace-insensitive comparison, used only to verify a write took effect. */
function sameContent(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

function cancel(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function isVisible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/**
 * Text of a textarea/input, or the rendered text of a contenteditable.
 * Trailing newlines are removed: an empty ProseMirror paragraph renders as
 * <p><br class="ProseMirror-trailingBreak"></p>, whose innerText is "\n".
 */
export function readEditorText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value;
  }
  return (el.innerText ?? el.textContent ?? "").replace(/\n+$/, "");
}

function firstVisible<T extends HTMLElement>(scope: ParentNode, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    for (const el of scope.querySelectorAll<T>(selector)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

function isEditable(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement)
  );
}

export class ChatGPTAdapter implements SiteAdapter {
  readonly id = CHATGPT.id;
  readonly displayName = CHATGPT.displayName;
  readonly capabilities = CAPABILITIES;

  /** True only while submitApproved() is synchronously triggering the send. */
  private bypassing = false;

  matches(url: URL): boolean {
    return hostnameMatches(url, CHATGPT.hostnames);
  }

  /** Visible composer forms on the page. */
  private composerForms(): HTMLFormElement[] {
    if (typeof document === "undefined") return [];
    const forms: HTMLFormElement[] = [];
    for (const selector of COMPOSER_FORM_SELECTORS) {
      for (const form of document.querySelectorAll<HTMLFormElement>(selector)) {
        if (isVisible(form) && !forms.includes(form)) forms.push(form);
      }
    }
    return forms;
  }

  private isComposerForm(form: HTMLFormElement): boolean {
    return COMPOSER_FORM_SELECTORS.some((selector) => form.matches(selector));
  }

  findEditor(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const known = firstVisible<HTMLElement>(document, EDITOR_SELECTORS);
    if (known) return known;
    // Fallback: any visible editable element inside a known composer form.
    for (const form of this.composerForms()) {
      const editable = firstVisible<HTMLElement>(form, [EDITABLE_FALLBACK_SELECTOR]);
      if (editable) return editable;
    }
    return null;
  }

  getPromptText(): string | null {
    const editor = this.findEditor();
    return editor ? readEditorText(editor) : null;
  }

  getIndicatorAnchor(): HTMLElement | null {
    const editor = this.findEditor();
    if (!editor) return null;
    return editor.closest<HTMLElement>("form") ?? editor;
  }

  observeInput(listener: (reason: InputReason) => void): Unsubscribe {
    if (typeof document === "undefined") return () => {};

    const isInEditor = (target: EventTarget | null): boolean => {
      const editor = this.findEditor();
      return !!editor && target instanceof Node && editor.contains(target);
    };
    const onInput = (event: Event): void => {
      if (isInEditor(event.target)) listener("input");
    };
    const onPaste = (event: Event): void => {
      if (isInEditor(event.target)) listener("paste");
    };

    const options: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("input", onInput, options);
    document.addEventListener("paste", onPaste, options);
    return () => {
      document.removeEventListener("input", onInput, options);
      document.removeEventListener("paste", onPaste, options);
    };
  }

  private isInEditor(target: EventTarget | null): boolean {
    const editor = this.findEditor();
    return !!editor && target instanceof Node && editor.contains(target);
  }

  /** The composer's send button, if visible. */
  findSendButton(): HTMLButtonElement | null {
    if (typeof document === "undefined") return null;
    const scope: ParentNode = this.findEditor()?.closest("form") ?? document;
    return firstVisible<HTMLButtonElement>(scope, SEND_BUTTON_SELECTORS);
  }

  isSiteBusy(): boolean {
    if (typeof document === "undefined") return false;
    const scope: ParentNode = this.findEditor()?.closest("form") ?? document;
    return firstVisible<HTMLButtonElement>(scope, STOP_BUTTON_SELECTORS) !== null;
  }

  observeComposer(listener: (change: ComposerChange) => void): Unsubscribe {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};

    let lastUrl = location.href;
    let lastEditor = this.findEditor();
    let scheduled: ReturnType<typeof setTimeout> | null = null;

    const check = (): void => {
      scheduled = null;
      const url = location.href;
      const editor = this.findEditor();
      const change: ComposerChange = {
        navigated: url !== lastUrl,
        editorChanged: editor !== lastEditor,
        hasEditor: editor !== null,
      };
      lastUrl = url;
      lastEditor = editor;
      listener(change);
    };
    // Coalesce bursts of mutations (typing, streaming replies) into one check.
    const schedule = (): void => {
      if (scheduled === null) scheduled = setTimeout(check, COMPOSER_CHECK_MS);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const fallback = setInterval(schedule, COMPOSER_FALLBACK_CHECK_MS);
    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);

    return () => {
      observer.disconnect();
      clearInterval(fallback);
      if (scheduled !== null) clearTimeout(scheduled);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }

  private sendButtonFromTarget(target: EventTarget | null): HTMLButtonElement | null {
    if (!(target instanceof Element)) return null;
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = target.closest<HTMLButtonElement>(selector);
      if (button) return button;
    }
    return null;
  }

  setPromptText(text: string): boolean {
    const editor = this.findEditor();
    if (!editor) return false;
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      // React-controlled textarea: use the native setter, then notify.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Contenteditable (ProseMirror): replace the whole content through the
      // browser's editing pipeline so the editor's own state is updated.
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
    }
    return sameContent(readEditorText(editor), text);
  }

  focusEditor(): void {
    const editor = this.findEditor();
    if (!editor) return;
    editor.focus();
    if (!(editor instanceof HTMLTextAreaElement)) {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  onSubmitAttempt(handler: SubmitHandler): Unsubscribe {
    if (typeof window === "undefined") return () => {};

    const intercept = (event: Event, source: SubmitSource): void => {
      cancel(event);
      handler(source);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (this.bypassing) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      const inComposer =
        this.isInEditor(event.target) ||
        // Fallback: an editable element inside the composer form, in case the
        // editor selectors stop matching.
        (isEditable(event.target) && this.composerForms().some((f) => f.contains(event.target as Node)));
      if (!inComposer) return;
      intercept(event, "enter");
    };
    const onClick = (event: MouseEvent): void => {
      if (this.bypassing) return;
      if (!this.sendButtonFromTarget(event.target)) return;
      intercept(event, "button");
    };
    const onSubmit = (event: Event): void => {
      if (this.bypassing) return;
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const editor = this.findEditor();
      if (!(editor && form.contains(editor)) && !this.isComposerForm(form)) return;
      intercept(event, "form");
    };

    const options: AddEventListenerOptions = { capture: true };
    window.addEventListener("keydown", onKeyDown, options);
    window.addEventListener("click", onClick, options);
    window.addEventListener("submit", onSubmit, options);
    return () => {
      window.removeEventListener("keydown", onKeyDown, options);
      window.removeEventListener("click", onClick, options);
      window.removeEventListener("submit", onSubmit, options);
    };
  }

  submitApproved(approvedText: string): boolean {
    const editor = this.findEditor();
    if (!editor || readEditorText(editor) !== approvedText) return false;
    const button = this.findSendButton();
    const form = editor.closest("form");
    if (button && button.disabled) return false; // site is not ready to send
    if (!button && !form) return false;

    this.bypassing = true;
    try {
      if (button) button.click();
      else form!.requestSubmit();
    } finally {
      this.bypassing = false;
    }
    return true;
  }
}
