/**
 * Cloud simulator service — the wire to the backend's cloud driver.
 *
 * Start/Stop are fire-and-forget commands: the ack only says the driver took
 * them; the OUTCOME arrives as a `cloud:simulator` status event plus the row
 * update. Device operations are request/response (`cloudSimExec`), answered
 * with the platform's exec result verbatim — a failed exec is data for the
 * caller, not an exception (the panel shows the platform's text).
 */

import { sendCommand, sendRequest } from "@/platform/ws";

/** Backend cloudSimExec deadline (60 s) plus a margin for the wire. */
const EXEC_TIMEOUT_MS = 65_000;
import type { CloudSimPlatform, CloudSimSeed } from "./cloudSimulatorStore";

export interface CloudSimExecResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
}

function withPlatform(
  params: Record<string, unknown>,
  platform: CloudSimPlatform | undefined
): Record<string, unknown> {
  return platform ? { ...params, platform } : params;
}

async function command(
  name: "cloudSim:start" | "cloudSim:stop",
  params: Record<string, unknown>,
  failure: string
): Promise<void> {
  const ack = await sendCommand(name, params);
  if (!ack.accepted) throw new Error(ack.error || failure);
}

export const cloudSimulatorService = {
  /** Boot a device; omit the platform to let the environment's default pick. */
  start: (workspaceId: string, platform?: CloudSimPlatform): Promise<void> =>
    command(
      "cloudSim:start",
      withPlatform({ workspaceId }, platform),
      "The device could not be started"
    ),

  /** Stop a device; omitting the platform stops every running device. */
  stop: (workspaceId: string, platform?: CloudSimPlatform): Promise<void> =>
    command(
      "cloudSim:stop",
      withPlatform({ workspaceId }, platform),
      "The device could not be stopped"
    ),

  /** The device's status right now — the backend's in-memory latest, else the
   *  platform's REST read; null when the platform knows of no device. The
   *  store seeds from this once per workspace, then lives on the events. */
  status: (workspaceId: string): Promise<CloudSimSeed | null> =>
    sendRequest<CloudSimSeed | null>("cloudSimulator", { workspaceId }),

  /** One device operation in the agent-device verb grammar
   *  (`press`, `fill`, `home`, `screenshot`, …). */
  exec: (
    workspaceId: string,
    verb: string,
    args?: string[],
    platform?: CloudSimPlatform
  ): Promise<CloudSimExecResult> =>
    sendRequest<CloudSimExecResult>(
      "cloudSimExec",
      withPlatform({ workspaceId, verb, ...(args ? { args } : {}) }, platform),
      // The backend waits 60 s for the device (a verb can wait on a UI
      // target); the client must outlast that or a slow verb rejects here
      // first and its late answer is dropped.
      { timeoutMs: EXEC_TIMEOUT_MS }
    ),

  /** The PNG does not come back here — it arrives as a `cloud:simulator`
   *  screenshot event (the platform fans captures out to every viewer). */
  screenshot: (workspaceId: string, platform?: CloudSimPlatform): Promise<CloudSimExecResult> =>
    cloudSimulatorService.exec(workspaceId, "screenshot", undefined, platform),

  /** Any exec counts as device activity for the platform's idle stop; a
   *  viewer keeps its device alive with the cheapest read there is. */
  keepAlive: (workspaceId: string, platform?: CloudSimPlatform): Promise<CloudSimExecResult> =>
    cloudSimulatorService.exec(workspaceId, "appstate", undefined, platform),
};
