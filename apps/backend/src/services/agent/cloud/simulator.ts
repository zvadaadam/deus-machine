// apps/backend/src/services/agent/cloud/simulator.ts
// The hosted simulator: agnt's EAS device attached to a cloud workspace's
// sandbox, as seen from deus. This module owns the device STATE and its
// effects; driver.ts owns the session socket and delegates every simulator.*
// frame here. The control API (start / stop / exec) stays with the driver
// because it rides the session channel — this file never imports the driver.
//
// The state is an in-memory cache, on purpose. The platform is the truth: it
// replays its latest simulator.status on every connect (the snapshot) and
// serves it over REST, so a copy on the workspace row would only ever be a
// stale second truth — a device stopped and billed off while this Mac was
// closed would still read "ready" — and the browser lane, which has no local
// database at all, could never share it. What the tab needs between frames is
// a cache, keyed by the workspace the device belongs to.

import { getSession as sdkGetSession } from "@deus-hq/sdk";
import {
  CloudSimulatorEventSchema,
  CloudSimulatorPlatformSchema,
  CloudSimulatorStatusSchema,
  type CloudSimulatorEvent,
  type CloudSimulatorPlatform,
  type CloudSimulatorStatus,
} from "@shared/events";
import { getCloudConfig } from "./config";
import { broadcast } from "../../ws.service";

/** The session a frame arrived on — the two ids the event envelope needs. */
export interface CloudSimulatorSource {
  workspaceId: string;
  sessionId: string;
}

interface CloudSimulatorEntry {
  /** The deus session that last spoke for the device (a synthesized park
   *  needs an envelope). */
  sessionId: string;
  status: CloudSimulatorStatus;
}
const cloudSimulators = new Map<string, CloudSimulatorEntry>();

/** Forget every device: identity change (the stream URLs were account A's
 *  phones) and driver shutdown. */
export function forgetCloudSimulators(): void {
  cloudSimulators.clear();
}

/** A status frame REPLACES the device state: the platform fans its full state
 *  out on every change, there is no partial update. The stream URL is a
 *  capability URL that dies with the device — never kept past a terminal
 *  status, whatever the frame carries; an error text only rides an error. */
function normalizeCloudSimulatorStatus(status: CloudSimulatorStatus): CloudSimulatorStatus {
  const terminal = status.status === "stopped" || status.status === "error";
  const { streamUrl, error, ...rest } = status;
  return {
    ...rest,
    ...(!terminal && streamUrl ? { streamUrl } : {}),
    ...(status.status === "error" && error ? { error } : {}),
  };
}

/** Push a device event to connected clients (q:event "cloud:simulator"). */
function broadcastCloudSimulator(event: CloudSimulatorEvent): void {
  broadcast(JSON.stringify({ type: "q:event", event: "cloud:simulator", data: event }));
}

/** Validate one platform simulator frame at the seam (like announceCloudEnv)
 *  and shape it as the q:event payload — the frame minus `type`. A malformed
 *  frame is dropped WITH a warning: unlike env progress, a missing device
 *  frame is a visible hole in the tab (a device that never shows up), so it
 *  has to leave a trace in the log. */
function parseCloudSimulatorEvent(
  source: CloudSimulatorSource,
  kind: CloudSimulatorEvent["kind"],
  frame: Record<string, unknown>
): CloudSimulatorEvent | null {
  const { type: _type, ...data } = frame;
  const parsed = CloudSimulatorEventSchema.safeParse({
    workspaceId: source.workspaceId,
    sessionId: source.sessionId,
    kind,
    data,
  });
  if (parsed.success) return parsed.data;
  console.warn(
    `[CloudSimulator] dropped malformed simulator ${kind} frame for workspace ${source.workspaceId}`
  );
  return null;
}

/** simulator.status — from the live frame or the snapshot's mirror. The cache
 *  first (a `cloudSimulator` read must never lag a broadcast), then the event. */
export function applyCloudSimulatorStatus(
  source: CloudSimulatorSource,
  frame: Record<string, unknown>
): void {
  const event = parseCloudSimulatorEvent(source, "status", frame);
  if (!event || event.kind !== "status") return;
  const data = normalizeCloudSimulatorStatus(event.data);
  cloudSimulators.set(source.workspaceId, { sessionId: source.sessionId, status: data });
  broadcastCloudSimulator({ ...event, data });
}

/** simulator.screenshot / simulator.action_result — live-only by design (the
 *  platform persists neither): the tab holds the last screenshot and a short
 *  ring of action results in memory. */
export function relayCloudSimulatorEvent(
  source: CloudSimulatorSource,
  kind: Exclude<CloudSimulatorEvent["kind"], "status">,
  frame: Record<string, unknown>
): void {
  const event = parseCloudSimulatorEvent(source, kind, frame);
  if (event) broadcastCloudSimulator(event);
}

/** The device died with its sandbox. Keep the platform (the tab still labels
 *  the device and offers Start on it), drop the capability URL and any stale
 *  error, mark it stopped — and tell the clients, since the platform's own
 *  settle frame may never arrive on a socket that is down. A workspace no
 *  device was ever known for stays unknown: a "stopped" phone must not appear
 *  on a workspace that never had one. */
export function parkCloudSimulator(workspaceId: string): void {
  const entry = cloudSimulators.get(workspaceId);
  if (!entry || entry.status.status === "stopped") return;
  const stopped = normalizeCloudSimulatorStatus({
    status: "stopped",
    ...(entry.status.platform ? { platform: entry.status.platform } : {}),
    ...(entry.status.easSessionIdentifier
      ? { easSessionIdentifier: entry.status.easSessionIdentifier }
      : {}),
    timestamp: new Date().toISOString(),
  });
  cloudSimulators.set(workspaceId, { sessionId: entry.sessionId, status: stopped });
  broadcastCloudSimulator({
    workspaceId,
    sessionId: entry.sessionId,
    kind: "status",
    data: stopped,
  });
}

// ---- The on-demand read ----

export interface CloudSimulatorReadContext {
  /** The workspace's current deus session, or null when it has none. */
  sessionId: string | null;
  /** That session's platform id — the REST read's key. */
  providerSessionId: string | null;
  /** Whether that session's socket is open right now: while it is, every
   *  change reaches the cache as a frame and the cache IS the platform's
   *  state; while it isn't, the cache is only as fresh as the last frame. */
  liveSocket: boolean;
}

/**
 * The workspace's device status right now. With a live socket the cache is
 * authoritative. Without one — this backend just started, the workspace was
 * never opened, or its socket dropped — the platform's REST read is preferred
 * (and cached), because a device may have stopped and been billed off since
 * the last frame; the cache only answers when the platform can't be reached.
 * null = the platform knows of no device.
 */
export async function readCloudSimulatorStatus(
  workspaceId: string,
  context: CloudSimulatorReadContext
): Promise<CloudSimulatorStatus | null> {
  const cached = cloudSimulators.get(workspaceId) ?? null;
  if (cached && context.liveSocket) return cached.status;
  const config = getCloudConfig();
  if (!config || !context.sessionId || !context.providerSessionId) return cached?.status ?? null;
  let raw: unknown;
  try {
    const detail = (await sdkGetSession(context.providerSessionId, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })) as { simulator?: unknown };
    raw = detail.simulator;
  } catch (err) {
    console.warn(`[CloudSimulator] status read failed for ${workspaceId}: ${String(err)}`);
    return cached?.status ?? null;
  }
  if (!raw || typeof raw !== "object") {
    // The platform knows of no device: whatever the cache held is history.
    cloudSimulators.delete(workspaceId);
    return null;
  }
  // REST is snake_case (the route re-cases the whole body); the socket is
  // camelCase. One shape past this point.
  const r = raw as Record<string, unknown>;
  const parsed = CloudSimulatorStatusSchema.safeParse({
    status: r.status,
    platform: r.platform,
    easSessionIdentifier: r.eas_session_identifier ?? r.easSessionIdentifier,
    streamUrl: r.stream_url ?? r.streamUrl,
    error: r.error,
    timestamp: r.timestamp,
  });
  if (!parsed.success) return cached?.status ?? null;
  const status = normalizeCloudSimulatorStatus(parsed.data);
  cloudSimulators.set(workspaceId, { sessionId: context.sessionId, status });
  return status;
}

// ---- Control-request shaping (the driver sends; this validates) ----

/** A device verb can install an app or wait on a UI target: 60 s covers the
 *  slow ones without letting a dead sidecar hang the tab forever. */
export const SIMULATOR_EXEC_TIMEOUT_MS = 60_000;
/** The platform's exec limits (SimulatorExecRequestDataSchema), enforced here
 *  so an oversized request fails at once: agnt answers an invalid frame with a
 *  channel error the pending map cannot correlate, and the caller would wait
 *  out the whole deadline. */
const SIMULATOR_EXEC_MAX_ARGS = 8;
const SIMULATOR_EXEC_MAX_ARG_LENGTH = 4096;

export interface CloudSimulatorExecRequest {
  /** Device verb (snapshot, press, fill, scroll, screenshot, appstate, …). */
  verb: string;
  args?: string[];
  platform?: CloudSimulatorPlatform;
}

/** The platform's verdict verbatim — a failed verb is a result, not an exception. */
export interface CloudSimulatorExecResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
}

/** Narrow a command/request `platform` param. Absent means the workspace's
 *  default device (start), every running device (stop) or the only one (exec). */
export function parseCloudSimulatorPlatform(value: unknown): CloudSimulatorPlatform | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = CloudSimulatorPlatformSchema.safeParse(value);
  if (!parsed.success) throw new Error('platform must be "ios" or "android"');
  return parsed.data;
}

/** The `simulator.exec.request` data for a validated request (undefined keys
 *  omitted — the platform's schema is strict about shape, not about absence). */
export function buildCloudSimulatorExecFrameData(
  request: CloudSimulatorExecRequest
): Record<string, unknown> {
  const verb = request.verb.trim();
  if (!verb) throw new Error("A simulator exec needs a verb");
  const args = request.args ?? [];
  if (args.length > SIMULATOR_EXEC_MAX_ARGS) {
    throw new Error(`A simulator exec takes at most ${SIMULATOR_EXEC_MAX_ARGS} args`);
  }
  if (args.some((arg) => arg.length > SIMULATOR_EXEC_MAX_ARG_LENGTH)) {
    throw new Error(
      `A simulator exec arg is limited to ${SIMULATOR_EXEC_MAX_ARG_LENGTH} characters`
    );
  }
  return {
    verb,
    ...(args.length > 0 ? { args } : {}),
    ...(request.platform ? { platform: request.platform } : {}),
  };
}

/** The platform's `simulator.exec.response`, as the request's result. */
export function readCloudSimulatorExecResult(
  data: Record<string, unknown>
): CloudSimulatorExecResult {
  const success = data.success === true;
  return {
    success,
    exitCode: typeof data.exitCode === "number" ? data.exitCode : success ? 0 : -1,
    output: typeof data.output === "string" ? data.output : "",
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}
