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

/** One hosted device, keyed under its workspace by platform. */
interface CloudSimulatorDevice {
  /** The deus session that last spoke for the device (a synthesized park
   *  needs an envelope). */
  sessionId: string;
  status: CloudSimulatorStatus;
  /** The platform's timestamp of the accepted status, epoch ms — the ordering
   *  gate. agnt fans every device transition out to EVERY session socket of
   *  the workspace, and two sockets' callbacks can interleave: a delayed
   *  `starting` copy must not overwrite the `ready` that already arrived (it
   *  would erase the live stream URL and leave the tab booting while the
   *  device runs — and bills). null until a frame named a time. */
  at: number | null;
  /** Set by a backend-synthesized park (the sandbox died under the device).
   *  While it holds, a frame with the SAME timestamp as `at` is the other
   *  socket's late copy of the pre-park state — a dead stream URL — and is
   *  refused too; only a genuinely later frame (a restart) applies. */
  parked: boolean;
}

/** A device's slot: its platform, or "unknown" for the backend-synthesized
 *  errors that name none (a sidecar that could not be reached). */
type PlatformKey = CloudSimulatorPlatform | "unknown";
type WorkspaceDevices = Map<PlatformKey, CloudSimulatorDevice>;

/**
 * workspaceId → platform → device. A workspace can run one device PER
 * platform (the sidecar admits ios and android side by side), and the
 * platform reports each on its own: an android `stopped` must not erase the
 * ios `ready` that is still running — and billing. The tab shows ONE device,
 * the workspace's primary (see `primaryOf`): the clients keep their
 * single-device shape and every broadcast carries the primary's status.
 */
const cloudSimulators = new Map<string, WorkspaceDevices>();

/** Recently relayed screenshot/action frames per workspace, so a capture the
 *  platform fanned out to two session sockets reaches the clients once. */
const recentRelays = new Map<string, string[]>();
const RECENT_RELAYS_KEPT = 16;

/** Bumped by forgetCloudSimulators (identity change, shutdown): a REST read
 *  that started under an earlier generation is account A's answer landing
 *  under account B, and is discarded. */
let cacheGeneration = 0;
/** Per-workspace mutation counter: every apply, park, REST write and REST
 *  delete bumps it. A REST read compares it across its await — entry
 *  identities alone cannot see a deletion (an empty map looks like "nothing
 *  landed"), so an older answer could repopulate a device a later answer
 *  had just declared gone. */
const cacheRevisions = new Map<string, number>();

function revisionOf(workspaceId: string): number {
  return cacheRevisions.get(workspaceId) ?? 0;
}

function bumpRevision(workspaceId: string): void {
  cacheRevisions.set(workspaceId, revisionOf(workspaceId) + 1);
}

/** How long the platform's REST read may take before the cache (or null)
 *  answers instead — a stalled connection must not pin a `cloudSimulator`
 *  request. */
const REST_READ_TIMEOUT_MS = 10_000;

/** The platform's ISO timestamp as epoch ms, or null when the frame named
 *  none (or an unparseable one — then it takes part in no ordering). */
function statusAt(status: CloudSimulatorStatus): number | null {
  if (!status.timestamp) return null;
  const at = Date.parse(status.timestamp);
  return Number.isFinite(at) ? at : null;
}

/** Forget every device: identity change (the stream URLs were account A's
 *  phones) and driver shutdown. */
export function forgetCloudSimulators(): void {
  cloudSimulators.clear();
  recentRelays.clear();
  cacheRevisions.clear();
  cacheGeneration += 1;
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

function sameStatus(a: CloudSimulatorStatus, b: CloudSimulatorStatus): boolean {
  return (
    a.status === b.status &&
    a.platform === b.platform &&
    a.streamUrl === b.streamUrl &&
    a.error === b.error &&
    a.easSessionIdentifier === b.easSessionIdentifier
  );
}

function platformKey(status: CloudSimulatorStatus): PlatformKey {
  return status.platform ?? "unknown";
}

function devicesOf(workspaceId: string): WorkspaceDevices {
  let devices = cloudSimulators.get(workspaceId);
  if (!devices) {
    devices = new Map();
    cloudSimulators.set(workspaceId, devices);
  }
  return devices;
}

/** How much a device deserves the tab: a running one always, then a booting
 *  one, then what is winding down, then the dead — so no other platform's
 *  transition can hide a device that is still up and billing. */
function statusRank(status: string): number {
  switch (status) {
    case "ready":
      return 0;
    case "starting":
      return 1;
    case "stopping":
      return 2;
    case "stopped":
      return 4;
    default:
      return 3; // error, or a status this build has never seen
  }
}

/** The workspace's primary device — the one the tab shows. Ties (two devices
 *  in the same state) go to the newer frame, then to ios for determinism. */
function primaryOf(devices: WorkspaceDevices | undefined): CloudSimulatorDevice | null {
  if (!devices || devices.size === 0) return null;
  let best: CloudSimulatorDevice | null = null;
  let bestKey: PlatformKey = "unknown";
  for (const [key, device] of devices) {
    if (!best) {
      best = device;
      bestKey = key;
      continue;
    }
    const rank = statusRank(device.status.status) - statusRank(best.status.status);
    if (rank < 0) {
      best = device;
      bestKey = key;
      continue;
    }
    if (rank > 0) continue;
    const newer = (device.at ?? -1) - (best.at ?? -1);
    if (newer > 0 || (newer === 0 && key === "ios" && bestKey !== "ios")) {
      best = device;
      bestKey = key;
    }
  }
  return best;
}

/** Push a device event to connected clients (q:event "cloud:simulator"). */
function broadcastCloudSimulator(event: CloudSimulatorEvent): void {
  broadcast(JSON.stringify({ type: "q:event", event: "cloud:simulator", data: event }));
}

/** Tell the clients the workspace's primary device changed — and only then.
 *  A transition on the OTHER platform (android stopping beside a running ios
 *  device) leaves the tab exactly as it was, so it says nothing. */
function announcePrimary(
  workspaceId: string,
  sessionId: string,
  before: CloudSimulatorStatus | null
): void {
  const after = primaryOf(cloudSimulators.get(workspaceId));
  if (!after) return;
  if (before && sameStatus(before, after.status)) return;
  broadcastCloudSimulator({ workspaceId, sessionId, kind: "status", data: after.status });
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

/** The ordering gate, shared by the socket and the REST paths. Older than
 *  what the cache holds: a late copy of a transition another source
 *  delivered first. Equal is a replay (the snapshot and the REST mirror the
 *  latest frame) and applies — same content, harmless — unless a park sits
 *  on that very timestamp: then it is the pre-park state coming back. And
 *  while parked, a status that names no time cannot prove it is newer (a
 *  real restart always carries the platform's time), so it is refused too. */
function isNotNewerThanCached(at: number | null, cached: CloudSimulatorDevice): boolean {
  if (at === null) return cached.parked;
  if (cached.at === null) return false;
  return at < cached.at || (at === cached.at && cached.parked);
}

/** simulator.status — from the live frame or the snapshot's mirror. The cache
 *  first (a `cloudSimulator` read must never lag a broadcast), then the event
 *  — which carries the workspace's PRIMARY device, not necessarily this frame. */
export function applyCloudSimulatorStatus(
  source: CloudSimulatorSource,
  frame: Record<string, unknown>
): void {
  const event = parseCloudSimulatorEvent(source, "status", frame);
  if (!event || event.kind !== "status") return;
  const data = normalizeCloudSimulatorStatus(event.data);
  const at = statusAt(data);
  const devices = devicesOf(source.workspaceId);
  const key = platformKey(data);
  const cached = devices.get(key);
  if (cached && isNotNewerThanCached(at, cached)) return;
  const before = primaryOf(devices)?.status ?? null;
  devices.set(key, {
    sessionId: source.sessionId,
    status: data,
    at: at ?? cached?.at ?? null,
    parked: false,
  });
  bumpRevision(source.workspaceId);
  announcePrimary(source.workspaceId, source.sessionId, before);
}

/** simulator.screenshot / simulator.action_result — live-only by design (the
 *  platform persists neither): the tab holds the last screenshot and a short
 *  ring of action results in memory. The platform fans each of them out to
 *  every session socket of the workspace; the clients get each ONCE. */
export function relayCloudSimulatorEvent(
  source: CloudSimulatorSource,
  kind: Exclude<CloudSimulatorEvent["kind"], "status" | "gone">,
  frame: Record<string, unknown>
): void {
  const event = parseCloudSimulatorEvent(source, kind, frame);
  if (!event) return;
  const stamp = typeof frame.timestamp === "string" ? frame.timestamp : null;
  if (stamp) {
    const dedupeKey = `${kind}|${stamp}|${String(frame.platform ?? "")}|${String(frame.verb ?? "")}`;
    const seen = recentRelays.get(source.workspaceId) ?? [];
    if (seen.includes(dedupeKey)) return;
    recentRelays.set(source.workspaceId, [...seen, dedupeKey].slice(-RECENT_RELAYS_KEPT));
  }
  broadcastCloudSimulator(event);
}

/** The devices died with their sandbox. Keep each platform (the tab still
 *  labels the device and offers Start on it), drop the capability URLs and
 *  any stale error, mark them stopped — and tell the clients, since the
 *  platform's own settle frames may never arrive on a socket that is down.
 *  A workspace no device was ever known for stays unknown: a "stopped" phone
 *  must not appear on a workspace that never had one. */
export function parkCloudSimulator(workspaceId: string): void {
  const devices = cloudSimulators.get(workspaceId);
  if (!devices || devices.size === 0) return;
  const before = primaryOf(devices)?.status ?? null;
  let sessionId: string | null = null;
  for (const [key, device] of devices) {
    if (device.status.status === "stopped") continue;
    sessionId ??= device.sessionId;
    const stopped = normalizeCloudSimulatorStatus({
      status: "stopped",
      ...(device.status.platform ? { platform: device.status.platform } : {}),
      ...(device.status.easSessionIdentifier
        ? { easSessionIdentifier: device.status.easSessionIdentifier }
        : {}),
      timestamp: new Date().toISOString(),
    });
    // Keep the PLATFORM's ordering point: the park is timed by this Mac's
    // clock and must never gate the platform's own frames (a resumed
    // sandbox's `starting` carries the platform's time, whatever this clock
    // says).
    devices.set(key, { sessionId: device.sessionId, status: stopped, at: device.at, parked: true });
  }
  if (sessionId === null) return; // everything was already stopped
  bumpRevision(workspaceId);
  announcePrimary(workspaceId, sessionId, before);
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
 * The workspace's primary device status right now. With a live socket the
 * cache is authoritative. Without one — this backend just started, the
 * workspace was never opened, or its socket dropped — the platform's REST
 * read is preferred (and cached), because a device may have stopped and been
 * billed off since the last frame; the cache only answers when the platform
 * can't be reached. null = the platform knows of no device.
 */
export async function readCloudSimulatorStatus(
  workspaceId: string,
  context: CloudSimulatorReadContext
): Promise<CloudSimulatorStatus | null> {
  const cachedPrimary = primaryOf(cloudSimulators.get(workspaceId));
  if (cachedPrimary && context.liveSocket) return cachedPrimary.status;
  const config = getCloudConfig();
  if (!config || !context.sessionId || !context.providerSessionId) {
    return cachedPrimary?.status ?? null;
  }
  const generation = cacheGeneration;
  const revisionBefore = revisionOf(workspaceId);
  // Entry identities before the await: every apply/park creates a new object,
  // so a changed identity afterwards means a frame landed for that platform.
  const before = new Map(cloudSimulators.get(workspaceId) ?? []);
  let detail: { simulator?: unknown; simulators?: unknown };
  try {
    detail = (await sdkGetSession(context.providerSessionId, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(REST_READ_TIMEOUT_MS),
    })) as { simulator?: unknown; simulators?: unknown };
  } catch (err) {
    console.warn(`[CloudSimulator] status read failed for ${workspaceId}: ${String(err)}`);
    return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
  }
  // The identity changed while the read was in flight: this is account A's
  // device (its stream URL) answering under account B. Not cached, not shown.
  if (generation !== cacheGeneration)
    return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
  // A platform that mirrors every device answers `simulators` (one per
  // platform, possibly empty); an older one mirrors only the latest status.
  const answers = Array.isArray(detail.simulators)
    ? detail.simulators
    : detail.simulator
      ? [detail.simulator]
      : [];
  const statuses = answers.map(parseRestStatus).filter((s) => s !== null);
  const devices = cloudSimulators.get(workspaceId);
  const changedMeanwhile = revisionOf(workspaceId) !== revisionBefore;
  const source: CloudSimulatorSource = { workspaceId, sessionId: context.sessionId };
  if (statuses.length === 0) {
    // Anything that landed meanwhile — a frame on a (re)connected socket, a
    // later REST answer — is the platform's later word; an answer computed
    // before it must not erase it.
    if (changedMeanwhile) return primaryOf(devices)?.status ?? null;
    // The platform knows of no device: whatever the cache held is history —
    // for every client, not just the one that asked.
    if (devices && devices.size > 0) {
      cloudSimulators.delete(workspaceId);
      bumpRevision(workspaceId);
      broadcastCloudSimulator({ ...source, kind: "gone", data: {} });
    }
    return null;
  }
  const beforePrimary = primaryOf(devices)?.status ?? null;
  let applied = false;
  for (const status of statuses) {
    const at = statusAt(status);
    const key = platformKey(status);
    const live = devices?.get(key) ?? null;
    // No entry for this platform but the workspace moved while we waited:
    // a later read may have declared the device gone (the map is emptied,
    // not marked) — this older answer must not bring it back.
    if (!live && changedMeanwhile) continue;
    // A frame for THIS platform landed meanwhile: only a strictly newer
    // answer may replace it.
    const thisLanded = live !== null && before.get(key) !== live;
    if (live && thisLanded && !(at !== null && live.at !== null && at > live.at)) continue;
    // The same gate the socket path applies: a REST mirror of the pre-park
    // frame (same timestamp) must not resurrect a dead stream URL, and an
    // older answer never wins.
    if (live && isNotNewerThanCached(at, live)) continue;
    devicesOf(workspaceId).set(key, { sessionId: context.sessionId, status, at, parked: false });
    applied = true;
  }
  if (!applied) return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
  bumpRevision(workspaceId);
  // The requester gets the answer; every other client learns it the same
  // way a socket frame would reach them — unless nothing changed.
  announcePrimary(workspaceId, context.sessionId, beforePrimary);
  return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
}

/** One REST device status → the socket shape. REST is snake_case (the route
 *  re-cases the whole body); the socket is camelCase. One shape past here;
 *  null for anything that is not a status. */
function parseRestStatus(raw: unknown): CloudSimulatorStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const parsed = CloudSimulatorStatusSchema.safeParse({
    status: r.status,
    platform: r.platform,
    easSessionIdentifier: r.eas_session_identifier ?? r.easSessionIdentifier,
    streamUrl: r.stream_url ?? r.streamUrl,
    error: r.error,
    timestamp: r.timestamp,
  });
  return parsed.success ? normalizeCloudSimulatorStatus(parsed.data) : null;
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
