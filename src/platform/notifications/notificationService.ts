/**
 * Native Notification Service
 *
 * Thin wrapper around @tauri-apps/plugin-notification for OS-level alerts.
 * Only fires when the app is in the background — foreground uses Sonner toasts.
 *
 * Sound names are macOS system sound identifiers:
 * - "Glass" — completion, success
 * - "Basso" — error, failure
 * - "Ping" — attention needed
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import { isTauriEnv } from "@/platform/tauri";

let permissionGranted = false;

/**
 * Request notification permission from the OS.
 * Safe to call multiple times — short-circuits if already granted.
 */
export async function initNotifications(): Promise<boolean> {
  if (!isTauriEnv) return false;

  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const result = await requestPermission();
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
}

/**
 * Send an OS-level notification. No-ops if permission not granted or not in Tauri.
 */
export function sendNotification({ title, body, sound }: NotificationOptions): void {
  if (!isTauriEnv || !permissionGranted) return;

  try {
    tauriSendNotification({ title, body, sound });
  } catch (e) {
    console.warn("[Notifications] Failed to send:", e);
  }
}
