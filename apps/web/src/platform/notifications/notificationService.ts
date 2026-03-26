/**
 * Native Notification Service
 *
 * Uses the Web Notification API (available in Electron renderer).
 * Only fires when the app is in the background — foreground uses Sonner toasts.
 *
 * Sound names are macOS system sound identifiers (kept for API compatibility,
 * but Electron's Web Notification API doesn't support custom sounds):
 * - "Glass" — completion, success
 * - "Basso" — error, failure
 * - "Ping" — attention needed
 */

import { capabilities } from "@/platform/capabilities";

let permissionGranted = false;

/**
 * Request notification permission from the OS.
 * Safe to call multiple times — short-circuits if already granted.
 */
export async function initNotifications(): Promise<boolean> {
  if (!capabilities.nativeNotifications) return false;

  try {
    if (!("Notification" in window)) {
      permissionGranted = false;
      return false;
    }

    if (Notification.permission === "granted") {
      permissionGranted = true;
    } else if (Notification.permission !== "denied") {
      const result = await Notification.requestPermission();
      permissionGranted = result === "granted";
    }
  } catch (e) {
    console.warn("[Notifications] Failed to request permission:", e);
    permissionGranted = false;
  }

  return permissionGranted;
}

export interface NotificationOptions {
  title: string;
  body?: string;
  sound?: "Glass" | "Basso" | "Ping";
  onClick?: () => void;
}

/**
 * Send an OS-level notification. No-ops if permission not granted or not in Electron.
 */
export function sendNotification({ title, body, onClick }: NotificationOptions): void {
  if (!capabilities.nativeNotifications || !permissionGranted) return;

  try {
    const n = new Notification(title, { body });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
      };
    }
  } catch (e) {
    console.warn("[Notifications] Failed to send:", e);
  }
}
