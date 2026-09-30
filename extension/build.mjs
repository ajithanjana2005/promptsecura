// PromptSecura extension build (esbuild).
//
//   node build.mjs               development build -> dist/
//   node build.mjs --production  minified, no source maps
//   node build.mjs --watch       rebuild on change
//   node build.mjs --outdir=DIR  write to DIR instead of dist/ (used by e2e tests)
//
// Configuration (environment variables):
//   PROMPTSECURA_BACKEND_URL  backend origin, default http://localhost:8000
//                             e.g. https://<codespace-name>-8000.app.github.dev
//   PROMPTSECURA_DEBUG        "true" to enable debug logging
//
// The backend origin is injected into the code and added to the manifest's
// host_permissions so the service worker may call it.

import * as esbuild from "esbuild";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const outdirArg = process.argv.find((a) => a.startsWith("--outdir="));
const DIST = outdirArg ? path.resolve(ROOT, outdirArg.slice("--outdir=".length)) : path.join(ROOT, "dist");
const DEFAULT_BACKEND_URL = "http://localhost:8000";

/** Validate and normalise the backend URL to a bare origin. Throws on invalid input. */
export function resolveBackendUrl(raw) {
  const value = (raw ?? "").trim() || DEFAULT_BACKEND_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PROMPTSECURA_BACKEND_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PROMPTSECURA_BACKEND_URL must use http or https");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(
      "PROMPTSECURA_BACKEND_URL must be an origin only (no path, query or fragment), " +
        `e.g. https://example-8000.app.github.dev — got ${JSON.stringify(value)}`,
    );
  }
  if (url.username || url.password) {
    throw new Error("PROMPTSECURA_BACKEND_URL must not contain credentials");
  }
  return url.origin;
}

export function parseDebug(raw) {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error(`PROMPTSECURA_DEBUG must be true/false, got ${JSON.stringify(raw)}`);
}

export function buildDefines(backendUrl, debug) {
  return {
    __PROMPTSECURA_BACKEND_URL__: JSON.stringify(backendUrl),
    __PROMPTSECURA_DEBUG__: JSON.stringify(debug),
  };
}

async function writeManifest(backendUrl) {
  const manifest = JSON.parse(await readFile(path.join(SRC, "manifest.json"), "utf8"));
  const permission = `${backendUrl}/*`;
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions ?? []), permission]));
  await writeFile(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

async function copyStatic() {
  await mkdir(path.join(DIST, "popup"), { recursive: true });
  await copyFile(path.join(SRC, "popup", "index.html"), path.join(DIST, "popup", "index.html"));
}

/** Fail the build if the manifest references files that were not produced. */
async function verifyManifestFiles(manifest) {
  const files = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ].filter(Boolean);
  for (const file of files) {
    try {
      await access(path.join(DIST, file));
    } catch {
      throw new Error(`manifest.json references ${file}, but it is missing from dist/`);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const watch = args.has("--watch");
  const production = args.has("--production");

  const backendUrl = resolveBackendUrl(process.env.PROMPTSECURA_BACKEND_URL);
  const debug = parseDebug(process.env.PROMPTSECURA_DEBUG);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const common = {
    bundle: true,
    platform: "browser",
    target: ["chrome120"],
    define: buildDefines(backendUrl, debug),
    minify: production,
    sourcemap: production ? false : "linked",
    legalComments: "none",
    logLevel: "info",
    outbase: SRC,
    outdir: DIST,
  };

  // Service worker is an ES module ("type": "module" in the manifest);
  // content scripts and the popup script must be classic scripts (IIFE).
  const configs = [
    { ...common, format: "esm", entryPoints: [path.join(SRC, "background", "service-worker.ts")] },
    {
      ...common,
      format: "iife",
      entryPoints: [path.join(SRC, "content", "index.ts"), path.join(SRC, "popup", "popup.ts")],
    },
  ];

  await copyStatic();
  const manifest = await writeManifest(backendUrl);

  if (watch) {
    for (const config of configs) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    console.log(`Watching for changes (backend: ${backendUrl}). Press Ctrl+C to stop.`);
    return;
  }

  await Promise.all(configs.map((config) => esbuild.build(config)));
  await verifyManifestFiles(manifest);
  console.log(
    `Built extension -> ${path.relative(process.cwd(), DIST) || "dist"} ` +
      `(backend: ${backendUrl}, debug: ${debug}, production: ${production})`,
  );
}

// Run only when executed directly, so tests can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Build failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
