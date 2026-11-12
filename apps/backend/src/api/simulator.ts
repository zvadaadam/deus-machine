/** Answers the operations in `shared/api/simulator.ts`. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as api from "@shared/api/simulator";
import {
  execCloudSimulator,
  getCloudSimulatorStatus,
  startCloudSimulator,
  stopCloudSimulator,
} from "../services/agent/cloud/driver";
import * as simulator from "../services/simulator-context";
import { broadcast } from "../services/ws.service";
import { handle } from "./registry";

const execFileAsync = promisify(execFile);

/**
 * A stream start or a build that failed after its request was answered. The
 * panel that asked is waiting on an event, so the failure goes out as one.
 */
function pushFailure(
  event: "sim:streamFailed" | "sim:buildFailed",
  workspaceId: string,
  err: unknown
): void {
  broadcast(
    JSON.stringify({
      type: "q:event",
      event,
      data: { workspaceId, error: err instanceof Error ? err.message : String(err) },
    })
  );
}

/** `simctl <verb>` for an app on the simulator the workspace is streaming. */
async function simctlApp(
  verb: "launch" | "terminate" | "uninstall",
  { workspaceId, bundleId }: { workspaceId: string; bundleId: string }
): Promise<void> {
  const session = simulator.getContextForWorkspace(workspaceId);
  if (!session) throw new Error("No active simulator session");
  await execFileAsync("xcrun", ["simctl", verb, session.udid, bundleId]);
}

export default [
  // ---- The iOS Simulator on this Mac ----
  handle(api.simulatorCapabilities, (_input, { caller }) =>
    simulator.getSimulatorCapabilities({ relayClient: caller.relayed })
  ),
  handle(api.simListDevices, async () => ({ devices: await simulator.listDevices() })),
  handle(api.simHasXcodeProject, async ({ workspacePath }) => ({
    hasProject: await simulator.hasXcodeProject(workspacePath),
  })),

  handle(api.simStart, ({ workspaceId, udid, skipBootCheck }, { caller }) => {
    const capabilities = simulator.getSimulatorCapabilities({ relayClient: caller.relayed });
    if (!capabilities.available) {
      throw new Error(capabilities.unavailableReason ?? "Simulator is unavailable");
    }
    // Not awaited: booting takes seconds. `sim:streamReady` says it worked.
    simulator.startStream(workspaceId, udid, skipBootCheck).catch((err) => {
      console.error("[Simulator] startStream failed:", err);
      pushFailure("sim:streamFailed", workspaceId, err);
    });
  }),
  handle(api.simStop, ({ workspaceId }) => simulator.stopStream(workspaceId)),
  handle(api.simTouch, ({ workspaceId, x, y, touchType }) =>
    simulator.sendTouch(workspaceId, x, y, touchType)
  ),
  handle(api.simScroll, ({ workspaceId, x, y, dx, dy }) =>
    simulator.sendScroll(workspaceId, x, y, dx, dy)
  ),
  handle(api.simKey, ({ workspaceId, keycode, direction }) =>
    simulator.sendKey(workspaceId, keycode, direction)
  ),
  handle(api.simButton, ({ workspaceId, buttonType }) =>
    simulator.sendButton(workspaceId, buttonType)
  ),
  handle(api.simScreenshot, async ({ workspaceId }) => ({
    bytes: await simulator.takeScreenshot(workspaceId),
  })),
  handle(api.simInspectStart, async ({ workspaceId, bundleId }) => ({
    snapshot: await simulator.startInspector(workspaceId, bundleId),
  })),
  handle(api.simInspectSnapshot, async ({ workspaceId }) => ({
    snapshot: await simulator.inspectorSnapshot(workspaceId),
  })),
  handle(api.simBuildAndRun, ({ workspaceId, workspacePath, scheme }) => {
    // Not awaited: a build takes minutes. `sim:buildLog` carries its output,
    // `sim:buildComplete` its result.
    simulator.buildAndRun(workspaceId, workspacePath, scheme).catch((err) => {
      pushFailure("sim:buildFailed", workspaceId, err);
    });
  }),
  handle(api.simLaunchApp, (app) => simctlApp("launch", app)),
  handle(api.simTerminateApp, (app) => simctlApp("terminate", app)),
  handle(api.simUninstallApp, (app) => simctlApp("uninstall", app)),

  // ---- The cloud device on a workspace's sandbox ----
  handle(api.cloudSimulator, ({ workspaceId }) => getCloudSimulatorStatus(workspaceId)),
  // Start and stop wait only for the send: an unreachable sandbox refuses the
  // request, and what the device then does arrives as `cloud:simulator` events.
  handle(api.cloudSimStart, ({ workspaceId, platform }) =>
    startCloudSimulator(workspaceId, platform)
  ),
  handle(api.cloudSimStop, ({ workspaceId, platform }) =>
    stopCloudSimulator(workspaceId, platform)
  ),
  // The platform's verdict is the answer, even a failed one: the panel shows its text.
  handle(api.cloudSimExec, ({ workspaceId, ...request }) =>
    execCloudSimulator(workspaceId, request)
  ),
];
