/**
 * Simulator Service — communicates with the backend via WebSocket commands.
 *
 * All operations go through the q:command protocol, which works identically
 * in desktop mode (WS to localhost) and web/relay mode (WS through relay).
 * No Electron IPC dependency.
 *
 * Commands are fire-and-forget (ack != completion). Stream lifecycle events
 * are pushed via q:event (sim:streamReady, sim:stopped, etc.).
 */

import { sendCommand, onEvent } from "@/platform/ws/query-protocol-client";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

export const simulatorService = {
  /** Fast probe: does this workspace contain a buildable Xcode project? */
  hasXcodeProject: async (workspacePath: string): Promise<boolean> => {
    try {
      const result = await sendCommand("sim:hasXcodeProject", { workspacePath });
      return (result as any)?.hasProject === true;
    } catch {
      return false;
    }
  },

  /** List available iOS simulators. */
  listSimulators: async (): Promise<SimulatorInfo[]> => {
    try {
      const result = await sendCommand("sim:listDevices", {});
      return ((result as any)?.devices ?? []) as SimulatorInfo[];
    } catch (err) {
      console.warn("[Simulator] listSimulators failed:", err);
      return [];
    }
  },

  /** Check if a streaming session is alive for this workspace.
   *  Panel uses event-driven recovery now — this returns null.
   *  The sim:streamReady event provides the stream URL on startup. */
  getStreamInfo: async (_workspaceId: string): Promise<StreamInfo | null> => {
    return null;
  },

  /**
   * Start streaming from a simulator. Fires q:command sim:start which
   * returns immediately (ack). The actual stream URL arrives via
   * q:event sim:streamReady { workspaceId, url, port, hidAvailable }.
   */
  startStreaming: async (
    workspaceId: string,
    udid: string,
    skipBootCheck = false
  ): Promise<StreamInfo> => {
    // Register listener BEFORE sending command to avoid race condition
    // (backend could push sim:streamReady before we start listening).
    return new Promise<StreamInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Simulator stream did not start within 30s"));
      }, 30_000);

      const cleanup = onEvent((event, data) => {
        // Debug: log ALL events while waiting for sim:streamReady
        if (event.startsWith("sim:")) {
          console.log("[Simulator] Received event:", event, data);
        }

        const d = data as any;
        if (d?.workspaceId !== workspaceId) return;

        if (event === "sim:streamReady") {
          clearTimeout(timeout);
          cleanup();
          console.log("[Simulator] Stream ready, resolving:", d.url);
          resolve({
            url: d.url,
            port: d.port,
            hid_available: d.hidAvailable ?? false,
          });
        }
        if (event === "sim:buildFailed") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(d.error ?? "Failed to start simulator"));
        }
      });

      console.log("[Simulator] Sending sim:start command for", udid);
      // Send the start command AFTER listener is registered
      sendCommand("sim:start", { workspaceId, udid, skipBootCheck }).catch((err) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      });
    });
  },

  stopStreaming: async (workspaceId: string): Promise<void> => {
    await sendCommand("sim:stop", { workspaceId });
  },

  sendTouch: (workspaceId: string, x: number, y: number, touchType: string) =>
    sendCommand("sim:touch", { workspaceId, x, y, touchType }),

  sendScroll: (workspaceId: string, x: number, y: number, dx: number, dy: number) =>
    sendCommand("sim:scroll", { workspaceId, x, y, dx, dy }),

  sendKey: (workspaceId: string, keycode: number, direction: string) =>
    sendCommand("sim:key", { workspaceId, keycode, direction }),

  sendButton: (workspaceId: string, buttonType: string) =>
    sendCommand("sim:button", { workspaceId, buttonType }),

  takeScreenshot: async (workspaceId: string): Promise<number[]> => {
    const result = await sendCommand("sim:screenshot", { workspaceId });
    return ((result as any)?.bytes ?? []) as number[];
  },

  pressHome: (workspaceId: string) =>
    sendCommand("sim:button", { workspaceId, buttonType: "home" }),

  launchApp: (workspaceId: string, bundleId: string) =>
    sendCommand("sim:launchApp", { workspaceId, bundleId }),

  terminateApp: (workspaceId: string, bundleId: string) =>
    sendCommand("sim:terminateApp", { workspaceId, bundleId }),

  uninstallApp: (workspaceId: string, bundleId: string) =>
    sendCommand("sim:uninstallApp", { workspaceId, bundleId }),

  buildAndRun: async (workspaceId: string, workspacePath: string): Promise<InstalledApp> => {
    // Register listener BEFORE sending command to avoid race condition
    return new Promise<InstalledApp>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Build timed out after 10 minutes"));
      }, 600_000);

      const cleanup = onEvent((event, data) => {
        const d = data as any;
        if (d?.workspaceId !== workspaceId) return;

        if (event === "sim:buildComplete") {
          clearTimeout(timeout);
          cleanup();
          resolve({
            bundle_id: d.bundleId ?? "",
            name: d.appName ?? "App",
            app_path: d.appPath ?? "",
          });
        }
        if (event === "sim:buildFailed") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(d.error ?? "Build failed"));
        }
      });

      sendCommand("sim:buildAndRun", { workspaceId, workspacePath }).catch((err) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      });
    });
  },
};
