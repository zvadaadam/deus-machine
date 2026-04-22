/**
 * Main-process helpers for the <webview>-based browser path.
 *
 * - Viewport emulation: needs CDP debugger attach (unreachable from the
 *   guest page's executeJavaScript).
 * - DevTools open: routed through the main side so we can pass a custom
 *   DevTools host webContents (a second <webview>) via
 *   `setDevToolsWebContents`. That's what lets DevTools render inline
 *   inside the browser panel; without it, guest DevTools always appear as
 *   a separate window.
 */

import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export interface EmulationParams {
  webContentsId: number;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  scale?: number;
}

export async function setEmulation(
  params: EmulationParams
): Promise<{ success: boolean; error?: string }> {
  if (!capabilities.nativeBrowser) return { success: false, error: "Not in Electron" };
  return (
    (await invoke<{ success: boolean; error?: string }>("browser_webview_emulation_set", {
      ...params,
    })) ?? { success: false, error: "No response" }
  );
}

export async function clearEmulation(
  webContentsId: number
): Promise<{ success: boolean; error?: string }> {
  if (!capabilities.nativeBrowser) return { success: false, error: "Not in Electron" };
  return (
    (await invoke<{ success: boolean; error?: string }>("browser_webview_emulation_clear", {
      webContentsId,
    })) ?? { success: false, error: "No response" }
  );
}

export type DevtoolsMode = "right" | "bottom" | "undocked" | "detach";

export interface OpenDevtoolsOptions {
  /** Render DevTools UI into this webContents (must be a fresh <webview>
   *  that hasn't navigated). When set, the DevTools appear inline inside
   *  whatever DOM the host webview lives in. `mode` is ignored. */
  devtoolsWebContentsId?: number;
  /** Dock mode for the default (no-custom-host) path. Ignored when
   *  `devtoolsWebContentsId` is set. Defaults to `detach` because docked
   *  modes silently fail for <webview> guests. */
  mode?: DevtoolsMode;
}

export async function openDevtools(
  webContentsId: number,
  options: OpenDevtoolsOptions = {}
): Promise<{ success: boolean; error?: string }> {
  if (!capabilities.nativeBrowser) return { success: false, error: "Not in Electron" };
  return (
    (await invoke<{ success: boolean; error?: string }>("browser_webview_devtools_open", {
      webContentsId,
      devtoolsWebContentsId: options.devtoolsWebContentsId,
      mode: options.mode ?? "detach",
    })) ?? { success: false, error: "No response" }
  );
}

export async function closeDevtools(
  webContentsId: number
): Promise<{ success: boolean; error?: string }> {
  if (!capabilities.nativeBrowser) return { success: false, error: "Not in Electron" };
  return (
    (await invoke<{ success: boolean; error?: string }>("browser_webview_devtools_close", {
      webContentsId,
    })) ?? { success: false, error: "No response" }
  );
}
