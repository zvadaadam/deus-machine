/**
 * Window Focus Detection
 *
 * Tracks whether the app window is currently focused at the OS level.
 * Used by the notification system to suppress OS notifications when the user
 * is already looking at the app (Sonner toasts handle that case).
 *
 * In Electron, uses standard `window.focus` and `window.blur` events which
 * correctly track OS-level window focus. Unlike `document.hidden` /
 * `visibilitychange`, these fire when the user switches to another app even
 * if the window is still partially visible (e.g., side-by-side windows).
 *
 * Falls back to `document.visibilitychange` in non-Electron environments
 * (e.g., `bun run dev:web`).
 */

import { capabilities } from "@/platform/capabilities";

let focused = true;

if (capabilities.nativeWindowChrome) {
  window.addEventListener("focus", () => {
    focused = true;
  });

  window.addEventListener("blur", () => {
    focused = false;
  });
} else {
  focused = !document.hidden;

  document.addEventListener("visibilitychange", () => {
    focused = !document.hidden;
  });
}

export function isWindowFocused(): boolean {
  return focused;
}
