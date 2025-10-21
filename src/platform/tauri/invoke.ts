/**
 * Tauri Platform Wrapper
 *
 * Provides a platform-independent interface for Tauri-specific APIs.
 * This abstraction allows for easier testing and potential platform swaps.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

// Check if running in Tauri environment
export const isTauriEnv = typeof window !== 'undefined' && '__TAURI__' in window;

/**
 * Invoke a Tauri command
 * Falls back to mock implementation in non-Tauri environments
 */
export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri invoke called in non-Tauri environment: ${command}`);
    throw new Error(`Tauri command not available in web mode: ${command}`);
  }

  return tauriInvoke<T>(command, args);
}

/**
 * Listen to Tauri events
 * Falls back to noop in non-Tauri environments
 */
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri listen called in non-Tauri environment: ${event}`);
    // Return noop unlisten function
    return () => {};
  }

  return tauriListen<T>(event, handler);
}

/**
 * Check if Tauri APIs are available
 */
export function isTauriAvailable(): boolean {
  return isTauriEnv;
}
