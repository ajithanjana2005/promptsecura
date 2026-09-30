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
 * DOM assumptions: ChatGPT's composer is a ProseMirror contenteditable with
 * id="prompt-textarea" (older builds used a <textarea> with that id) inside a
 * <form>, with a send button marked data-testid="send-button". These
 * selectors were NOT verified against the live site from the development
 * environment; if ChatGPT changes its markup, update EDITOR_SELECTORS and
 * SEND_BUTTON_SELECTORS below. All ChatGPT-specific selectors live here.
 */

import { SUPPORTED_SITES, type SupportedSite } from "../../shared/config";
import type {
  AdapterCapabilities,
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

/** Text of a textarea/input, or the rendered text of a contenteditable. */
export function readEditorText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value;
  }
  return el.innerText ?? el.textContent ?? "";
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

  findEditor(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    for (const selector of EDITOR_SELECTORS) {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (isVisible(el)) return el;
      }
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
    for (const selector of SEND_BUTTON_SELECTORS) {
      for (const el of scope.querySelectorAll<HTMLButtonElement>(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
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
      if (!this.isInEditor(event.target)) return;
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
      const editor = this.findEditor();
      if (!(form instanceof HTMLFormElement) || !editor || !form.contains(editor)) return;
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
