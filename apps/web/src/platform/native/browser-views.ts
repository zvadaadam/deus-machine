/**
 * Main-process helpers for the <webview>-based browser path.
 *
 * - Viewport emulation: needs CDP debugger attach (unreachable from the
 *   guest page's executeJavaScript).
 * - DevTools open: routed through the main side so we can manage state
 *   (close from our toolbar, track open/closed). Guest webContents always
 *   open detached — docked modes (`bottom`/`right`) silently fail because
 *   a <webview> guest doesn't own a BrowserWindow to dock into (see
 *   Electron docs on `webContents.openDevTools`).
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

export async function openDevtools(
  webContentsId: number,
  mode: DevtoolsMode = "detach"
): Promise<{ success: boolean; error?: string }> {
  if (!capabilities.nativeBrowser) return { success: false, error: "Not in Electron" };
  return (
    (await invoke<{ success: boolean; error?: string }>("browser_webview_devtools_open", {
      webContentsId,
      mode,
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
