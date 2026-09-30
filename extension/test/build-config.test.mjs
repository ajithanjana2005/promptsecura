import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDefines, parseDebug, resolveBackendUrl } from "../build.mjs";

test("backend URL defaults to localhost:8000", () => {
  assert.equal(resolveBackendUrl(undefined), "http://localhost:8000");
  assert.equal(resolveBackendUrl("  "), "http://localhost:8000");
});

test("backend URL is normalised to an origin", () => {
  assert.equal(
    resolveBackendUrl("https://my-space-8000.app.github.dev/"),
    "https://my-space-8000.app.github.dev",
  );
  assert.equal(resolveBackendUrl("HTTP://LOCALHOST:8000"), "http://localhost:8000");
});

test("invalid backend URLs are rejected", () => {
  for (const bad of [
    "not a url",
    "ftp://example.com",
    "https://example.com/api",
    "https://example.com/?x=1",
    "https://user:pw@example.com",
    "chrome-extension://abc",
  ]) {
    assert.throws(() => resolveBackendUrl(bad), undefined, bad);
  }
});

test("debug flag parsing", () => {
  assert.equal(parseDebug(undefined), false);
  assert.equal(parseDebug("true"), true);
  assert.equal(parseDebug("0"), false);
  assert.throws(() => parseDebug("yes please"));
});

test("defines are JSON literals", () => {
  assert.deepEqual(buildDefines("http://localhost:8000", false), {
    __PROMPTSECURA_BACKEND_URL__: '"http://localhost:8000"',
    __PROMPTSECURA_DEBUG__: "false",
  });
});
