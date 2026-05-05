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
import type { InstalledApp, InspectorSnapshot, SimulatorInfo, StreamInfo } from "../types";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function workspacePayload(data: unknown, workspaceId: string): Record<string, unknown> | null {
  const payload = asRecord(data);
  return payload.workspaceId === workspaceId ? payload : null;
}

function eventError(payload: Record<string, unknown>, fallback: string): Error {
  return new Error(asString(payload.error) ?? fallback);
}

function parseStreamInfo(payload: Record<string, unknown>): StreamInfo | null {
  const url = asString(payload.url);
  const port = asNumber(payload.port);
  if (!url || port === null) return null;
  return {
    url,
    port,
    hid_available: payload.hidAvailable === true,
  };
}

function parseInstalledApp(payload: Record<string, unknown>): InstalledApp {
  return {
    bundle_id: asString(payload.bundleId) ?? "",
    name: asString(payload.appName) ?? "App",
    app_path: asString(payload.appPath) ?? "",
  };
}

function parseInspectorSnapshot(result: unknown): InspectorSnapshot {
  const snapshot = asRecord(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Malformed inspector snapshot response");
  }
  return snapshot as InspectorSnapshot;
}

export const simulatorService = {
  /** Fast probe: does this workspace contain a buildable Xcode project? */
  hasXcodeProject: async (workspacePath: string): Promise<boolean> => {
    try {
      const result = await sendCommand("sim:hasXcodeProject", { workspacePath });
      return asRecord(result).hasProject === true;
    } catch {
      return false;
    }
  },

  /** List available iOS simulators. */
  listSimulators: async (): Promise<SimulatorInfo[]> => {
    try {
      const result = await sendCommand("sim:listDevices", {});
      const devices = asRecord(result).devices;
      return Array.isArray(devices) ? (devices as SimulatorInfo[]) : [];
    } catch (err) {
      console.warn("[Simulator] listSimulators failed:", err);
      return [];
    }
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
        const payload = workspacePayload(data, workspaceId);
        if (!payload) return;

        if (event === "sim:streamReady") {
          clearTimeout(timeout);
          cleanup();
          const stream = parseStreamInfo(payload);
          if (stream) resolve(stream);
          else reject(new Error("Malformed simulator streamReady event"));
        }
        if (event === "sim:streamFailed") {
          clearTimeout(timeout);
          cleanup();
          reject(eventError(payload, "Failed to start simulator"));
        }
      });

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
    const bytes = asRecord(result).bytes;
    return Array.isArray(bytes)
      ? bytes.filter((byte): byte is number => typeof byte === "number")
      : [];
  },

  startInspect: async (workspaceId: string, bundleId?: string): Promise<InspectorSnapshot> => {
    const result = await sendCommand("sim:inspectStart", { workspaceId, bundleId });
    return parseInspectorSnapshot(result);
  },

  inspectSnapshot: async (workspaceId: string): Promise<InspectorSnapshot> => {
    const result = await sendCommand("sim:inspectSnapshot", { workspaceId });
    return parseInspectorSnapshot(result);
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
        const payload = workspacePayload(data, workspaceId);
        if (!payload) return;

        if (event === "sim:buildComplete") {
          clearTimeout(timeout);
          cleanup();
          resolve(parseInstalledApp(payload));
        }
        if (event === "sim:buildFailed") {
          clearTimeout(timeout);
          cleanup();
          reject(eventError(payload, "Build failed"));
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
