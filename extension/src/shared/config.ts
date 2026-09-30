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
 * Composer observation (Phase 6). A MutationObserver on <body> schedules a
 * check at most once per COMPOSER_CHECK_MS; it catches changes that fire no
 * input event (ChatGPT clearing the editor after Send, a new chat replacing
 * the editor, SPA navigation). A slow fallback timer covers anything the
 * observer might miss.
 */
export const COMPOSER_CHECK_MS = 150;
export const COMPOSER_FALLBACK_CHECK_MS = 2_000;

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
