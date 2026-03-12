/**
 * Window Focus Detection
 *
 * Tracks whether the app window is currently focused at the OS level.
 * Used by the notification system to suppress OS notifications when the user
 * is already looking at the app (Sonner toasts handle that case).
 *
 * Uses Tauri's `tauri://focus` and `tauri://blur` events which correctly
 * track OS-level window focus. Unlike `document.hidden` / `visibilitychange`,
 * these fire when the user switches to another app even if the Tauri window
 * is still partially visible (e.g., side-by-side windows).
 *
 * Falls back to `document.visibilitychange` in non-Tauri environments
 * (e.g., `bun run dev:web`).
 */

import { useSyncExternalStore } from "react";
import { listen, isTauriEnv } from "@/platform/tauri";

// Assume focused on startup — the app window is in the foreground when it launches
let focused = true;

// Subscribers for useSyncExternalStore notifications
const subscribers = new Set<() => void>();

function notifySubscribers() {
  for (const callback of subscribers) {
    callback();
  }
}

/**
 * Set up Tauri window focus/blur listeners at module level.
 * These fire on OS-level focus changes — not just tab visibility.
 *
 * Intentionally module-level (no cleanup): This is a process-lifetime singleton.
 * The focused state is shared across all React component instances via
 * useSyncExternalStore. The listeners live for the app's entire lifetime,
 * matching the lifetime of the Tauri window they track. Cleaning them up
 * would break isWindowFocused() calls from non-React code (e.g., notification
 * handlers in useGlobalSessionNotifications).
 */
if (isTauriEnv) {
  (async () => {
    await listen("tauri://focus", () => {
      focused = true;
      notifySubscribers();
    });

    await listen("tauri://blur", () => {
      focused = false;
      notifySubscribers();
    });
  })();
} else {
  // Fallback for dev mode (bun run dev:web) — use visibilitychange
  focused = !document.hidden;

  document.addEventListener("visibilitychange", () => {
    focused = !document.hidden;
    notifySubscribers();
  });
}

// useSyncExternalStore requires subscribe + getSnapshot
function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function getSnapshot() {
  return focused;
}

/**
 * Returns true when the app window is focused (OS-level).
 * Uses useSyncExternalStore for tear-free reads.
 */
export function useWindowFocus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Non-hook version for use outside React components (e.g., event handlers).
 */
export function isWindowFocused(): boolean {
  return focused;
}
