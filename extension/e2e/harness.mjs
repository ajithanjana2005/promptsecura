// Shared e2e harness: builds the extension against the fixture backend,
// launches Chromium with it loaded, and serves the ChatGPT fixture page at the
// real ChatGPT origins through request routing (no network access needed).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createAnalyzeServer } from "./fixtures/analyze-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".e2e-dist");
const FIXTURE = readFileSync(path.join(ROOT, "e2e", "fixtures", "chatgpt.html"), "utf8");
export const PORT = 18765;
export const FAIL_MSG = "PromptSecura could not complete the security analysis.";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildExtension() {
  const result = spawnSync(process.execPath, ["build.mjs", `--outdir=${OUT}`], {
    cwd: ROOT,
    env: { ...process.env, PROMPTSECURA_BACKEND_URL: `http://127.0.0.1:${PORT}`, PROMPTSECURA_DEBUG: "true" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`extension build failed:\n${result.stdout}\n${result.stderr}`);
}

export async function setup() {
  buildExtension();
  const server = createAnalyzeServer(PORT);
  await server.start();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "promptsecura-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", // full Chromium in new headless mode: supports extensions
    headless: true,
    viewport: { width: 1200, height: 800 },
    executablePath: process.env.PROMPTSECURA_E2E_CHROMIUM || undefined,
    args: [`--disable-extensions-except=${OUT}`, `--load-extension=${OUT}`],
  });
  for (const origin of ["https://chatgpt.com", "https://chat.openai.com"]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: FIXTURE }),
    );
  }
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 15000 });

  const allSent = [];
  const consoleLines = [];

  async function openChat(url = "https://chatgpt.com/") {
    const page = await context.newPage();
    const pageLines = [];
    page.on("console", (m) => {
      consoleLines.push(m.text());
      pageLines.push(m.text());
    });
    await page.goto(url);
    const ready = await waitFor(async () => pageLines.some((l) => l.includes("protection active")), 5000);
    if (!ready) throw new Error(`content script did not start on ${url}`);
    return new ChatPage(page, allSent, pageLines);
  }

  async function teardown() {
    await context.close();
    await server.stop().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }

  return { server, context, openChat, teardown, allSent, consoleLines };
}

export async function waitFor(predicate, timeout = 4000, interval = 40) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  return false;
}

/** Page helpers for the ChatGPT fixture. */
export class ChatPage {
  constructor(page, allSent, consoleLines) {
    this.page = page;
    this.allSent = allSent;
    this.consoleLines = consoleLines;
  }
  editor() {
    return this.page.locator('form[data-type="unified-composer"] [contenteditable="true"]');
  }
  panel() {
    return this.page.locator("#promptsecura-enforcement-host .panel");
  }
  pill() {
    return this.page.locator("#promptsecura-indicator-host .pill");
  }
  async sent() {
    return this.page.evaluate(() => window.__sent.map((s) => s.t));
  }
  /** Records what the page (= ChatGPT) received, for global safety assertions. */
  async record() {
    this.allSent.push(...(await this.sent()));
  }
  async clear() {
    await this.editor().click();
    await this.page.keyboard.press("Control+A");
    await this.page.keyboard.press("Backspace");
  }
  async type(text) {
    await this.editor().click();
    await this.page.keyboard.type(text, { delay: 2 });
  }
  async setText(text) {
    await this.clear();
    await this.type(text);
  }
  async enter() {
    await this.editor().click();
    await this.page.keyboard.press("End");
    await this.page.keyboard.press("Enter");
  }
  async clickSend() {
    await this.page.click('[data-testid="send-button"]');
  }
  async panelVariant() {
    return (await this.panel().isVisible().catch(() => false)) ? this.panel().getAttribute("data-variant") : null;
  }
  async waitPanel(variant, timeout = 4000) {
    return waitFor(async () => (await this.panelVariant()) === variant, timeout);
  }
  async waitSent(n, timeout = 4000) {
    return waitFor(async () => (await this.sent()).length >= n, timeout);
  }
  async indicatorLabel() {
    return (await this.pill().isVisible().catch(() => false)) ? this.pill().locator(".label").textContent() : null;
  }
  async waitIndicator(label, timeout = 4000) {
    return waitFor(async () => (await this.indicatorLabel()) === label, timeout);
  }
  /** Wait until the fixture's simulated reply has finished streaming. */
  async waitIdle(timeout = 4000) {
    return waitFor(async () => (await this.page.locator('[data-testid="stop-button"]').count()) === 0, timeout);
  }
  async paste(text) {
    await this.editor().click();
    await this.page.evaluate((t) => {
      const ed = document.querySelector('form[data-type="unified-composer"] [contenteditable="true"]');
      ed.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      document.execCommand("insertText", false, t);
    }, text);
  }
  async close() {
    await this.record();
    await this.page.close();
  }
}
