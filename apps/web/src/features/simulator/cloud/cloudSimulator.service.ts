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

/** How long a device operation may take end to end: without a session
 *  socket the backend first mints a token and waits up to READY_DEADLINE_MS
 *  (30 s) for the handshake, THEN starts its own 60 s exec deadline — the
 *  client must outlast both, or a slow but valid operation rejects here
 *  while the backend goes on to succeed (and a screenshot's capture, landing
 *  after the request was forgotten, attaches to nothing). */
export const EXEC_TIMEOUT_MS = 100_000;
/** Start/Stop are acked once the driver has a session socket to send on.
 *  Without one it mints a token and waits up to READY_DEADLINE_MS (30 s) for
 *  the handshake first — the ack must outlast that, or the panel reports a
 *  failure (and drops its busy state) for a command the backend then sends. */
const COMMAND_TIMEOUT_MS = 75_000;
import type { CloudSimPlatform, CloudSimSeed } from "./cloudSimulatorStore";

export interface CloudSimExecResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
  /** The platform's clock when it answered (ISO) — what a screenshot
   *  request correlates its capture against. */
  timestamp?: string;
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
  const ack = await sendCommand(name, params, COMMAND_TIMEOUT_MS);
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
