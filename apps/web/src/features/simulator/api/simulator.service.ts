/**
 * The simulator operations that need more than one call.
 *
 * Starting a stream and building an app answer at once and report their
 * outcome later as q:event frames (sim:streamReady, sim:buildComplete, …);
 * the functions here wait for that event. Everything else the panel does is a
 * plain `call(api.sim…)`.
 */

import { api } from "@shared/api";
import { call, onEvent } from "@/platform/ws";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

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

export const simulatorService = {
  /** The simulators installed on the backend's Mac; none when they cannot be listed. */
  listSimulators: async (): Promise<SimulatorInfo[]> => {
    try {
      // CoreSimulator can take longer than the default 30 s to answer on a fresh macOS install.
      const { devices } = await call(api.simListDevices, {}, { timeoutMs: 45_000 });
      return devices;
    } catch (err) {
      console.warn("[Simulator] listSimulators failed:", err);
      return [];
    }
  },

  /**
   * Start streaming from a simulator. `sim:start` answers at once; the stream
   * URL arrives as q:event sim:streamReady { workspaceId, url, port, hidAvailable }.
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
      call(api.simStart, { workspaceId, udid, skipBootCheck }).catch((err) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      });
    });
  },

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

      call(api.simBuildAndRun, { workspaceId, workspacePath }).catch((err) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      });
    });
  },
};
