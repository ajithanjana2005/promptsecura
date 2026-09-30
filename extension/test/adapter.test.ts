import assert from "node:assert/strict";
import { test } from "node:test";

import { findAdapter, hostnameMatches } from "../src/content/sites/adapter";
import { ChatGPTAdapter } from "../src/content/sites/chatgpt";

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

test("ChatGPT placeholder adapter declares no capabilities and does nothing", () => {
  assert.equal(adapter.id, "chatgpt");
  assert.equal(adapter.displayName, "ChatGPT");
  assert.deepEqual({ ...adapter.capabilities }, {
    readPrompt: false,
    writePrompt: false,
    interceptSubmit: false,
  });
  assert.equal(adapter.getPromptText(), null);
  assert.equal(adapter.setPromptText("x"), false);
  let called = false;
  const unsubscribe = adapter.onSubmitAttempt(async () => {
    called = true;
    return true;
  });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(called, false);
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
