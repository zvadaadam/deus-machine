/**
 * The simulator operations that need more than one call.
 *
 * Starting a stream and building an app answer at once and report their
 * outcome later on the workspace's `simulatorEvents`; the functions here wait
 * for it. Everything else the panel does is a plain `call(api.sim…)`.
 */

import { api } from "@shared/api";
import type { SimulatorEvent } from "@shared/api/simulator";
import { call, follow } from "@/platform/ws";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

/**
 * Ask for something and wait for the workspace's simulator to report how it
 * went. It listens before it asks, so an outcome that comes at once is heard.
 * `settle` answers with the result or the failure, or nothing for an event
 * that is not the outcome.
 */
function outcome<T>(
  workspaceId: string,
  ask: () => Promise<unknown>,
  settle: (event: SimulatorEvent) => T | Error | undefined,
  timeout: { ms: number; message: string }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (result: T | Error) => {
      clearTimeout(timer);
      stop();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(timeout.message)), timeout.ms);
    const stop = follow(api.simulatorEvents, { workspaceId }, (event) => {
      const result = settle(event);
      if (result !== undefined) finish(result);
    });
    ask().catch((error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error)))
    );
  });
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

  /** Start streaming from a simulator, and wait for its stream. */
  startStreaming: (workspaceId: string, udid: string, skipBootCheck = false): Promise<StreamInfo> =>
    outcome(
      workspaceId,
      () => call(api.simStart, { workspaceId, udid, skipBootCheck }),
      (event) => {
        if (event.type === "streamReady") {
          return { url: event.url, port: event.port, hid_available: event.hidAvailable };
        }
        if (event.type === "streamFailed") return new Error(event.error);
        return undefined;
      },
      { ms: 30_000, message: "Simulator stream did not start within 30s" }
    ),

  /** Build the workspace's app and run it on its simulator, and wait for the build. */
  buildAndRun: (workspaceId: string, workspacePath: string): Promise<InstalledApp> =>
    outcome(
      workspaceId,
      () => call(api.simBuildAndRun, { workspaceId, workspacePath }),
      (event) => {
        if (event.type === "buildComplete") {
          return { bundle_id: event.bundleId, name: event.appName, app_path: event.appPath };
        }
        if (event.type === "buildFailed") return new Error(event.error);
        return undefined;
      },
      { ms: 600_000, message: "Build timed out after 10 minutes" }
    ),
};
