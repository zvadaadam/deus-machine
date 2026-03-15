/**
 * Tauri Platform Wrapper
 *
 * Provides a platform-independent interface for Tauri-specific APIs.
 * This abstraction allows for easier testing and potential platform swaps.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit as tauriEmit, listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalizeError, reportError } from "@/shared/utils/errorReporting";
import { AppEventSchemaMap, type AppEventMap, type AppEventName } from "@shared/events";

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
 * Type-safe event listener.
 *
 * When called with a known event name from AppEventMap, the payload type
 * is inferred automatically — no manual generic needed:
 *
 *   listen(WORKSPACE_PROGRESS, (e) => e.payload.workspaceId)  // payload is WorkspaceProgressEvent
 *
 * Also accepts arbitrary event names with an explicit generic for backwards
 * compat during incremental migration:
 *
 *   listen<MyType>("custom:event", handler)
 */
export async function listen<K extends AppEventName>(
  event: K,
  handler: (event: { payload: AppEventMap[K] }) => void
): Promise<UnlistenFn>;
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<UnlistenFn>;
export async function listen(
  event: string,
  handler: (event: { payload: unknown }) => void
): Promise<UnlistenFn> {
  if (!isTauriEnv) {
    console.warn(`[Platform] Tauri listen called in non-Tauri environment: ${event}`);
    return () => {};
  }

  const schema = (AppEventSchemaMap as Record<string, import("zod").ZodTypeAny>)[event];
  if (!schema) {
    // Unknown event (not in AppEventMap) — pass through without validation
    return tauriListen(event, handler);
  }

  return tauriListen(event, (e) => {
    const result = schema.safeParse(e.payload);
    if (!result.success) {
      console.error(
        `[Platform] Event "${event}" payload failed schema validation:`,
        result.error.format()
      );
      // Still deliver the original payload so the app doesn't break —
      // the console.error is enough to surface Rust↔TS drift during dev.
      handler(e);
      return;
    }
    // Pass validated + stripped payload (extra keys removed by Zod)
    handler({ ...e, payload: result.data });
  });
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
