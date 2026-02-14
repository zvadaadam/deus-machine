/**
 * Tauri Platform Wrapper
 *
 * Provides a platform-independent interface for Tauri-specific APIs.
 * This abstraction allows for easier testing and potential platform swaps.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit as tauriEmit, listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalizeError, reportError } from "@/shared/utils/errorReporting";

// Check if running in Tauri environment
export const isTauriEnv =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window || "__TAURI_IPC__" in window);

/**
 * Invoke a Tauri command
 * Falls back to mock implementation in non-Tauri environments
 */
export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri invoke called in non-Tauri environment: ${command}`);
    throw new Error(`Tauri command not available in web mode: ${command}`);
  }

  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    const normalized = normalizeError(error);
    reportError(normalized, {
      source: "tauri.invoke",
      action: command,
      extra: { argsKeys: args ? Object.keys(args) : undefined },
    });
    throw normalized;
  }
}

/**
 * Listen to Tauri events
 * Falls back to noop in non-Tauri environments
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<UnlistenFn> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri listen called in non-Tauri environment: ${event}`);
    // Return noop unlisten function
    return () => {};
  }

  return tauriListen<T>(event, handler);
}

/**
 * Emit a Tauri event (broadcasts to all windows)
 */
export async function emit<T>(event: string, payload?: T): Promise<void> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri emit called in non-Tauri environment: ${event}`);
    return;
  }

  return tauriEmit(event, payload);
}

/**
 * Check if Tauri APIs are available
 */
export function isTauriAvailable(): boolean {
  return isTauriEnv;
}
