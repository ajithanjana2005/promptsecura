/**
 * Minimal logger. Callers must pass only metadata (ids, lengths, decisions,
 * error kinds). Never pass prompt text, sanitized text or PII.
 */

import { DEBUG } from "./config";

const PREFIX = "[PromptSecura]";

export const log = {
  debug(...args: unknown[]): void {
    if (DEBUG) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
