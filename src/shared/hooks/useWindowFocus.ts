/**
 * Window Focus Detection
 *
 * Tracks whether the app window is currently visible/focused.
 * Used by the notification system to suppress OS notifications when the user
 * is already looking at the app (Sonner toasts handle that case).
 */

import { useSyncExternalStore } from "react";

let focused = !document.hidden;

function handleVisibilityChange() {
  focused = !document.hidden;
}

document.addEventListener("visibilitychange", handleVisibilityChange);

// useSyncExternalStore requires subscribe + getSnapshot
function subscribe(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getSnapshot() {
  return focused;
}

/**
 * Returns true when the app window is visible and in the foreground.
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
