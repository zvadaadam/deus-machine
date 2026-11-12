/**
 * Cloud simulator service — the device operations, with the deadlines they need.
 *
 * Start/Stop answer once the driver took them; the OUTCOME arrives as a
 * `cloudSimulatorEvents` status event plus the row update. A device operation
 * (`cloudSimExec`) is answered with the platform's exec result verbatim — a
 * failed exec is data for the caller, not an exception (the panel shows the
 * platform's text).
 */

import { api } from "@shared/api";
import type { CloudSimulatorExecResult } from "@shared/types/simulator";
import { call } from "@/platform/ws";
import type { CloudSimPlatform } from "./cloudSimulatorStore";

/** How long a device operation may take end to end: without a session
 *  socket the backend first mints a token and waits up to READY_DEADLINE_MS
 *  (30 s) for the handshake, THEN starts its own 60 s exec deadline — the
 *  client must outlast both, or a slow but valid operation rejects here
 *  while the backend goes on to succeed (and a screenshot's capture, landing
 *  after the request was forgotten, attaches to nothing). */
export const EXEC_TIMEOUT_MS = 100_000;
/** Start/Stop are answered once the driver has a session socket to send on.
 *  Without one it mints a token and waits up to READY_DEADLINE_MS (30 s) for
 *  the handshake first — the answer must outlast that, or the panel reports a
 *  failure (and drops its busy state) for a command the backend then sends. */
export const COMMAND_TIMEOUT_MS = 75_000;

export const cloudSimulatorService = {
  /** Boot a device; omit the platform to let the environment's default pick. */
  start: (workspaceId: string, platform?: CloudSimPlatform): Promise<void> =>
    call(api.cloudSimStart, { workspaceId, platform }, { timeoutMs: COMMAND_TIMEOUT_MS }),

  /** Stop a device; omitting the platform stops every running device. */
  stop: (workspaceId: string, platform?: CloudSimPlatform): Promise<void> =>
    call(api.cloudSimStop, { workspaceId, platform }, { timeoutMs: COMMAND_TIMEOUT_MS }),

  /** One device operation in the agent-device verb grammar
   *  (`press`, `fill`, `home`, `screenshot`, …). A verb acts on the device, so
   *  a lost answer is an unknown outcome, never a safe retry. */
  exec: (
    workspaceId: string,
    verb: string,
    args?: string[],
    platform?: CloudSimPlatform
  ): Promise<CloudSimulatorExecResult> =>
    call(api.cloudSimExec, { workspaceId, verb, args, platform }, { timeoutMs: EXEC_TIMEOUT_MS }),

  /** The PNG does not come back here — it arrives as a `cloudSimulatorEvents`
   *  screenshot event (the platform fans captures out to every viewer). */
  screenshot: (
    workspaceId: string,
    platform?: CloudSimPlatform
  ): Promise<CloudSimulatorExecResult> =>
    cloudSimulatorService.exec(workspaceId, "screenshot", undefined, platform),

  /** Any exec counts as device activity for the platform's idle stop; a
   *  viewer keeps its device alive with the cheapest read there is. */
  keepAlive: (
    workspaceId: string,
    platform?: CloudSimPlatform
  ): Promise<CloudSimulatorExecResult> =>
    cloudSimulatorService.exec(workspaceId, "appstate", undefined, platform),
};
