/**
 * Extension configuration.
 *
 * Values marked "build-time" are injected by build.mjs through esbuild's
 * `define`, from environment variables:
 *
 *   PROMPTSECURA_BACKEND_URL   backend origin (default http://localhost:8000)
 *   PROMPTSECURA_DEBUG         "true" enables debug logging (default false)
 *
 * The backend URL is also added to the manifest's host_permissions at build
 * time, so the service worker is allowed to call it. Rebuild after changing it.
 */

import type { SiteId } from "./types";

declare const __PROMPTSECURA_BACKEND_URL__: string;
declare const __PROMPTSECURA_DEBUG__: boolean;

/** Backend origin without a trailing slash (build-time). */
export const BACKEND_URL: string = __PROMPTSECURA_BACKEND_URL__;

/** Enables debug logging. Logs never include prompt text (build-time). */
export const DEBUG: boolean = __PROMPTSECURA_DEBUG__;

export const API_PATHS = {
  analyze: "/api/v1/analyze",
  health: "/health",
} as const;

/** How long to wait for the backend before failing closed. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Wait this long after the last keystroke before analyzing (content script). */
export const TYPING_DEBOUNCE_MS = 600;

/** Shorter wait after a paste, since the text arrives all at once. */
export const PASTE_DEBOUNCE_MS = 150;

/**
 * How often the content script re-checks the editor. Catches changes that
 * fire no input event (e.g. ChatGPT clearing the editor after Send, or a new
 * chat replacing the editor) and keeps the indicator positioned.
 */
export const EDITOR_POLL_MS = 1_000;

/** Shown whenever no security decision could be made. Matches the backend. */
export const FAIL_CLOSED_MESSAGE = "PromptSecura could not complete the security analysis.";

export interface SupportedSite {
  id: SiteId;
  displayName: string;
  /** Hostnames the site adapter is responsible for. */
  hostnames: readonly string[];
}

/** Keep hostnames in sync with content_scripts.matches in manifest.json. */
export const SUPPORTED_SITES: readonly SupportedSite[] = [
  { id: "chatgpt", displayName: "ChatGPT", hostnames: ["chatgpt.com", "chat.openai.com"] },
];
