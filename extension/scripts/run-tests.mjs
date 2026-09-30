// Bundles test/*.test.ts with esbuild (same defines as a real build) and
// runs them, plus test/*.test.mjs, with Node's built-in test runner.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDefines } from "../build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT, "test");
const OUT_DIR = path.join(ROOT, ".test-dist");

const entries = await readdir(TEST_DIR);
const tsTests = entries.filter((f) => f.endsWith(".test.ts")).map((f) => path.join(TEST_DIR, f));
const mjsTests = entries.filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(TEST_DIR, f));

await rm(OUT_DIR, { recursive: true, force: true });
await esbuild.build({
  entryPoints: tsTests,
  outdir: OUT_DIR,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  define: buildDefines("http://backend.test", false),
  logLevel: "warning",
});

const bundled = tsTests.map((f) => path.join(OUT_DIR, path.basename(f).replace(/\.ts$/, ".mjs")));
const result = spawnSync(process.execPath, ["--test", ...bundled, ...mjsTests], {
  stdio: "inherit",
});
await rm(OUT_DIR, { recursive: true, force: true });
process.exit(result.status ?? 1);
