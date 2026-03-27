/**
 * Electron Platform Wrapper
 *
 * Provides a platform-independent interface for Electron-specific APIs.
 * Provides invoke(), listen(), and emit() for IPC with the Electron main process.
 *
 * All IPC goes through window.electronAPI (exposed by the preload script).
 */

import { normalizeError, reportError } from "@/shared/utils/errorReporting";
import { AppEventSchemaMap, type AppEventMap, type AppEventName } from "@shared/events";

// Check if running in Electron environment (preload script exposes electronAPI)
export const isElectronEnv = typeof window !== "undefined" && "electronAPI" in window;

/**
 * Invoke an Electron IPC command via the preload bridge.
 * Falls back to error in non-Electron environments.
 */
export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isElectronEnv) {
    console.warn(`[Platform] Electron invoke called in non-Electron environment: ${command}`);
    throw new Error(`Electron command not available in web mode: ${command}`);
  }

  try {
    return (await window.electronAPI!.invoke(command, args)) as T;
  } catch (error) {
    const normalized = normalizeError(error);
    reportError(normalized, {
      source: "electron.invoke",
      action: command,
      extra: { argsKeys: args ? Object.keys(args) : undefined },
    });
    throw normalized;
  }
}

/**
 * Type-safe event listener for Electron IPC events.
 *
 * When called with a known event name from AppEventMap, the payload type
 * is inferred automatically:
 *
 *   listen(WORKSPACE_PROGRESS, (e) => e.payload.workspaceId)
 *
 * Also accepts arbitrary event names with an explicit generic for backwards
 * compat during incremental migration.
 *
 * Returns a Promise<UnlistenFn> for API consistency,
 * even though Electron's IPC returns unsubscribe synchronously.
 */
export async function listen<K extends AppEventName>(
  event: K,
  handler: (event: { payload: AppEventMap[K] }) => void
): Promise<() => void>;
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void>;
export async function listen(
  event: string,
  handler: (event: { payload: unknown }) => void
): Promise<() => void> {
  if (!isElectronEnv) {
    console.warn(`[Platform] Electron listen called in non-Electron environment: ${event}`);
    return () => {};
  }

  const schema = (AppEventSchemaMap as Record<string, import("zod").ZodTypeAny>)[event];

  // Register via preload bridge — electronAPI.on returns a sync unsubscribe fn.
  // We wrap the callback to match the { payload } shape expected by consumers.
  const unlisten = window.electronAPI!.on(event, (...args: unknown[]) => {
    // Electron IPC sends payload as the first arg after the stripped IpcRendererEvent
    const payload = args[0];

    if (!schema) {
      // Unknown event (not in AppEventMap) — pass through without validation
      handler({ payload });
      return;
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      console.error(
        `[Platform] Event "${event}" payload failed schema validation:`,
        result.error.format()
      );
      // Still deliver the original payload so the app doesn't break
      handler({ payload });
      return;
    }
    // Pass validated + stripped payload (extra keys removed by Zod)
    handler({ payload: result.data });
  });

  return unlisten;
}

/**
 * Emit an event (send to main process, which can broadcast to all windows)
 */
export async function emit<T>(event: string, payload?: T): Promise<void> {
  if (!isElectronEnv) {
    console.warn(`[Platform] Electron emit called in non-Electron environment: ${event}`);
    return;
  }

  window.electronAPI!.send(event, payload);
}
