import assert from "node:assert/strict";
import { test } from "node:test";

import { findAdapter, hostnameMatches } from "../src/content/sites/adapter";
import {
  ChatGPTAdapter,
  COMPOSER_FORM_SELECTORS,
  EDITOR_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
} from "../src/content/sites/chatgpt";

const adapter = new ChatGPTAdapter();

test("ChatGPT adapter matches ChatGPT hosts over HTTPS only", () => {
  assert.ok(adapter.matches(new URL("https://chatgpt.com/")));
  assert.ok(adapter.matches(new URL("https://chatgpt.com/c/123")));
  assert.ok(adapter.matches(new URL("https://chat.openai.com/")));
  assert.ok(adapter.matches(new URL("https://CHATGPT.com/")));
  assert.equal(adapter.matches(new URL("http://chatgpt.com/")), false);
  assert.equal(adapter.matches(new URL("https://chatgpt.com.evil.example/")), false);
  assert.equal(adapter.matches(new URL("https://notchatgpt.com/")), false);
  assert.equal(adapter.matches(new URL("https://gemini.google.com/")), false);
});

test("ChatGPT adapter declares all capabilities (enforcement)", () => {
  assert.equal(adapter.id, "chatgpt");
  assert.equal(adapter.displayName, "ChatGPT");
  assert.deepEqual({ ...adapter.capabilities }, {
    readPrompt: true,
    observeInput: true,
    writePrompt: true,
    interceptSubmit: true,
  });
});

test("ChatGPT adapter is inert without a DOM", () => {
  assert.equal(adapter.findEditor(), null);
  assert.equal(adapter.getPromptText(), null);
  assert.equal(adapter.getIndicatorAnchor(), null);
  const stop = adapter.observeInput(() => {});
  assert.equal(typeof stop, "function");
  stop();
  // No DOM: nothing can be written or submitted.
  assert.equal(adapter.findSendButton(), null);
  assert.equal(adapter.submitApproved("anything"), false);
  const unsubscribe = adapter.onSubmitAttempt(() => {});
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
});

test("composer observation and readiness are inert without a DOM", () => {
  assert.equal(adapter.isSiteBusy(), false);
  const stop = adapter.observeComposer(() => {
    throw new Error("must not be called without a DOM");
  });
  assert.equal(typeof stop, "function");
  stop();
});

test("composer-form and stop-button selectors are ChatGPT-specific", () => {
  assert.equal(COMPOSER_FORM_SELECTORS[0], 'form[data-type="unified-composer"]');
  assert.ok(COMPOSER_FORM_SELECTORS.every((s) => s.startsWith("form")));
  assert.equal(STOP_BUTTON_SELECTORS[0], 'button[data-testid="stop-button"]');
});

test("send-button selectors are ChatGPT-specific and isolated in the adapter", () => {
  assert.equal(SEND_BUTTON_SELECTORS[0], 'button[data-testid="send-button"]');
  assert.ok(SEND_BUTTON_SELECTORS.every((s) => s.startsWith("button")));
});

test("editor selectors target the ChatGPT composer, most specific first", () => {
  assert.equal(EDITOR_SELECTORS[0], '#prompt-textarea[contenteditable="true"]');
  assert.ok(EDITOR_SELECTORS.every((s) => s.includes("prompt-textarea") || s.includes("ProseMirror")));
});

test("findAdapter picks the matching adapter or null", () => {
  assert.equal(findAdapter(new URL("https://chatgpt.com/"), [adapter]), adapter);
  assert.equal(findAdapter(new URL("https://example.com/"), [adapter]), null);
  assert.equal(findAdapter(new URL("https://chatgpt.com/"), []), null);
});

test("hostnameMatches is exact and case-insensitive", () => {
  assert.ok(hostnameMatches(new URL("https://Example.COM/x"), ["example.com"]));
  assert.equal(hostnameMatches(new URL("https://sub.example.com/"), ["example.com"]), false);
});
