/**
 * Popup script.
 *
 * Static information only. The backend status is a placeholder
 * ("Not checked"); a real /health check is a later phase. Nothing here
 * reports a backend state it has not actually observed.
 */

import { BACKEND_URL, SUPPORTED_SITES } from "../shared/config";

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function render(): void {
  setText("version", `v${chrome.runtime.getManifest().version}`);
  setText("supported-sites", SUPPORTED_SITES.map((s) => s.displayName).join(", "));
  setText("backend-url", BACKEND_URL);
}

document.addEventListener("DOMContentLoaded", render);
