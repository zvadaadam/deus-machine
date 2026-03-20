/**
 * Simulator Service — wraps Electron IPC calls to macOS Xcode/Simulator native handlers.
 *
 * All methods degrade gracefully when Electron IPC is unavailable (e.g., web dev mode).
 * Data-query methods return safe defaults; action methods throw so callers can surface errors.
 * These native handlers require the Electron desktop app with Xcode tooling on macOS.
 */

import { invoke } from "@/platform/electron";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

export const simulatorService = {
  /** Fast probe: does this workspace contain a buildable Xcode project?
   *  Returns false when Electron IPC is unavailable. */
  hasXcodeProject: async (workspacePath: string): Promise<boolean> => {
    try {
      return await invoke<boolean>("sim_has_xcode_project", { workspacePath });
    } catch (err) {
      console.warn("[Simulator] hasXcodeProject unavailable (requires Electron native handler):", err);
      return false;
    }
  },

  /** List available iOS simulators.
   *  Returns empty array when Electron IPC is unavailable. */
  listSimulators: async (): Promise<SimulatorInfo[]> => {
    try {
      return await invoke<SimulatorInfo[]>("list_simulators");
    } catch (err) {
      console.warn("[Simulator] listSimulators unavailable (requires Electron native handler):", err);
      return [];
    }
  },

  /** Check if a streaming session is alive for this workspace.
   *  Returns null when Electron IPC is unavailable. */
  getStreamInfo: async (workspaceId: string): Promise<StreamInfo | null> => {
    try {
      return await invoke<StreamInfo | null>("get_stream_info", { workspaceId });
    } catch (err) {
      console.warn("[Simulator] getStreamInfo unavailable (requires Electron native handler):", err);
      return null;
    }
  },

  /** Start streaming from a simulator. Throws on failure — callers must handle errors. */
  startStreaming: async (
    workspaceId: string,
    udid: string,
    skipBootCheck = false
  ): Promise<StreamInfo> => {
    try {
      return await invoke<StreamInfo>("start_streaming", { workspaceId, udid, skipBootCheck });
    } catch (err) {
      console.warn("[Simulator] startStreaming unavailable (requires Electron native handler):", err);
      throw err;
    }
  },

  stopStreaming: (workspaceId: string) => invoke<void>("stop_streaming", { workspaceId }),

  sendTouch: (workspaceId: string, x: number, y: number, touchType: string) =>
    invoke<void>("sim_send_touch", { workspaceId, x, y, touchType }),

  sendScroll: (workspaceId: string, x: number, y: number, dx: number, dy: number) =>
    invoke<void>("sim_send_scroll", { workspaceId, x, y, dx, dy }),

  sendKey: (workspaceId: string, keycode: number, direction: string) =>
    invoke<void>("sim_send_key", { workspaceId, keycode, direction }),

  sendButton: (workspaceId: string, buttonType: string, direction: string) =>
    invoke<void>("sim_send_button", { workspaceId, buttonType, direction }),

  takeScreenshot: (workspaceId: string) => invoke<number[]>("sim_take_screenshot", { workspaceId }),

  pressHome: (workspaceId: string) => invoke<void>("sim_press_home", { workspaceId }),

  installApp: (workspaceId: string, appPath: string) =>
    invoke<InstalledApp>("sim_install_app", { workspaceId, appPath }),

  launchApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_launch_app", { workspaceId, bundleId }),

  terminateApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_terminate_app", { workspaceId, bundleId }),

  uninstallApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_uninstall_app", { workspaceId, bundleId }),

  buildAndRun: (workspaceId: string, workspacePath: string) =>
    invoke<InstalledApp>("sim_build_and_run", { workspaceId, workspacePath }),
};
