/**
 * ChatGPT site adapter — READ-ONLY (Phase 4).
 *
 * Can:     find the prompt editor, read its text, observe typing/paste.
 * Cannot:  write the prompt or intercept submits (enforcement is a later
 *          phase); those capabilities are declared false and the methods are
 *          inert.
 *
 * Non-interference guarantees:
 *   - Only `input` and `paste` listeners are registered, on `document`, in the
 *     capture phase, as passive listeners. They never call preventDefault(),
 *     stopPropagation() or modify the event.
 *   - No keydown, submit or click listeners: ChatGPT's Send (Enter key and
 *     send button) is completely unaffected.
 *   - The adapter never writes to ChatGPT's DOM.
 *
 * DOM assumptions: ChatGPT's composer is a ProseMirror contenteditable with
 * id="prompt-textarea" (older builds used a <textarea> with that id), plus a
 * hidden fallback <textarea>. These selectors were NOT verified against the
 * live site from the development environment; if ChatGPT changes its markup,
 * update EDITOR_SELECTORS below.
 */

import { SUPPORTED_SITES, type SupportedSite } from "../../shared/config";
import type {
  AdapterCapabilities,
  InputReason,
  SiteAdapter,
  SubmitHandler,
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

const CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  readPrompt: true,
  observeInput: true,
  writePrompt: false,
  interceptSubmit: false,
});

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

  setPromptText(_text: string): boolean {
    return false; // writePrompt: not in the read-only phase
  }

  onSubmitAttempt(_handler: SubmitHandler): Unsubscribe {
    return () => {}; // interceptSubmit: not in the read-only phase; registers nothing
  }
}
