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
  /** Where the entry came from: a socket frame (the platform's push) or a
   *  REST answer — and which read wrote it. A REST read that finds an entry
   *  rewritten meanwhile must know whether a frame overtook it (keep) or an
   *  EARLIER-issued read merely answered late (this later read still wins,
   *  pruning included). */
  origin: "socket" | "rest";
  restIssue: number | null;
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
/** Socket-originated mutations (apply, park) per workspace. A REST answer
 *  computed before one of them landed is the platform's EARLIER word. */
const socketRevisions = new Map<string, number>();

function socketRevisionOf(workspaceId: string): number {
  return socketRevisions.get(workspaceId) ?? 0;
}

function bumpSocketRevision(workspaceId: string): void {
  socketRevisions.set(workspaceId, socketRevisionOf(workspaceId) + 1);
}

/** REST reads per workspace, numbered as they are issued: `issued` is the
 *  last number handed out, `answered` the highest number whose read has
 *  applied its answer. A read issued EARLIER than one that already answered
 *  is stale whatever it says; a read issued LATER may replace what the
 *  earlier one wrote — including an empty answer clearing a device the
 *  earlier read had just reported. Entry identities alone cannot order two
 *  reads (an emptied map looks like "nothing landed"). */
const restReads = new Map<string, { issued: number; answered: number }>();

function issueRestRead(workspaceId: string): number {
  const reads = restReads.get(workspaceId) ?? { issued: 0, answered: 0 };
  reads.issued += 1;
  restReads.set(workspaceId, reads);
  return reads.issued;
}

function restAnsweredAfter(workspaceId: string, issue: number): boolean {
  return (restReads.get(workspaceId)?.answered ?? 0) > issue;
}

function markRestAnswered(workspaceId: string, issue: number): void {
  const reads = restReads.get(workspaceId) ?? { issued: issue, answered: 0 };
  reads.answered = Math.max(reads.answered, issue);
  restReads.set(workspaceId, reads);
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
  socketRevisions.clear();
  restReads.clear();
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

/** The same status, from the same moment. A frame identical in content but
 *  newer in time is the platform answering AGAIN (a retried start failing the
 *  same way) and must reach the clients: the renderer clears its pending
 *  action on any status event, so swallowing it would leave "Booting the
 *  device" over a real error. Equal timestamps are replays (the snapshot and
 *  the REST mirror repeat the latest frame) and stay silent. */
function sameStatus(a: CloudSimulatorStatus, b: CloudSimulatorStatus): boolean {
  return (
    a.status === b.status &&
    a.platform === b.platform &&
    a.streamUrl === b.streamUrl &&
    a.error === b.error &&
    a.easSessionIdentifier === b.easSessionIdentifier &&
    a.timestamp === b.timestamp
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
    origin: "socket",
    restIssue: null,
    parked: false,
  });
  // A platformless error is the platform's word about a COMMAND (a start it
  // could not attribute to a device), kept under "unknown" until a device
  // speaks: any platform-bearing status supersedes it — left behind, it
  // would outrank the device's later `stopped` and show as an error again.
  if (key !== "unknown") devices.delete("unknown");
  bumpSocketRevision(source.workspaceId);
  announcePrimary(source.workspaceId, source.sessionId, before);
}

/**
 * A (re)connect snapshot's per-platform mirror is this session's COMPLETE
 * list: a cached platform it no longer names was removed while the socket
 * was down — and with the socket live again, no REST read would ever notice.
 * Only entries THIS session spoke for are pruned: the platform mirrors per
 * session, and a session created after another session's device started
 * never saw that device's frames — its silence about it is not evidence.
 */
export function reconcileCloudSimulatorMirror(
  source: CloudSimulatorSource,
  mirrors: Record<string, unknown>[]
): void {
  const before = primaryOf(cloudSimulators.get(source.workspaceId))?.status ?? null;
  for (const mirror of mirrors) applyCloudSimulatorStatus(source, mirror);
  const devices = cloudSimulators.get(source.workspaceId);
  if (!devices) return;
  const named = new Set(
    mirrors.map((mirror) => {
      const parsed = CloudSimulatorStatusSchema.safeParse(mirror);
      return parsed.success ? platformKey(parsed.data) : null;
    })
  );
  let pruned = false;
  for (const [key, entry] of [...devices]) {
    if (named.has(key) || entry.sessionId !== source.sessionId) continue;
    devices.delete(key);
    pruned = true;
  }
  if (!pruned) return;
  bumpSocketRevision(source.workspaceId);
  if (devices.size === 0) {
    cloudSimulators.delete(source.workspaceId);
    broadcastCloudSimulator({ ...source, kind: "gone", data: {} });
    return;
  }
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
    devices.set(key, {
      sessionId: device.sessionId,
      status: stopped,
      at: device.at,
      origin: "socket",
      restIssue: null,
      parked: true,
    });
  }
  if (sessionId === null) return; // everything was already stopped
  bumpSocketRevision(workspaceId);
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
  const issue = issueRestRead(workspaceId);
  const socketRevisionBefore = socketRevisionOf(workspaceId);
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
  // Superseded: a socket frame landed while this read was in flight, or a
  // read issued AFTER this one has already applied its answer. Either is the
  // platform's later word; this answer must not overwrite it. (A read issued
  // EARLIER answering meanwhile is not: this read asked later, it may
  // replace what that one wrote.)
  const superseded =
    socketRevisionOf(workspaceId) !== socketRevisionBefore || restAnsweredAfter(workspaceId, issue);
  const source: CloudSimulatorSource = { workspaceId, sessionId: context.sessionId };
  // An entry rewritten while this read was in flight was overtaken only if a
  // socket frame wrote it, or a read issued AFTER this one did; an
  // earlier-issued read answering late does not outrank this later read.
  const overtaken = (key: PlatformKey, entry: CloudSimulatorDevice): boolean =>
    before.get(key) !== entry && (entry.origin === "socket" || (entry.restIssue ?? 0) > issue);
  if (statuses.length === 0) {
    if (superseded) return primaryOf(devices)?.status ?? null;
    markRestAnswered(workspaceId, issue);
    // The session knows of no device: whatever it spoke for is history — for
    // every client, not just the one that asked. Another session's entries
    // stay: the platform mirrors per session, and this one may simply have
    // been created after that device started.
    if (devices && devices.size > 0) {
      for (const [key, entry] of [...devices]) {
        if (entry.sessionId === context.sessionId) devices.delete(key);
      }
      if (devices.size === 0) {
        cloudSimulators.delete(workspaceId);
        broadcastCloudSimulator({ ...source, kind: "gone", data: {} });
      }
    }
    return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
  }
  if (!superseded) markRestAnswered(workspaceId, issue);
  const beforePrimary = primaryOf(devices)?.status ?? null;
  let applied = false;
  for (const status of statuses) {
    const at = statusAt(status);
    const key = platformKey(status);
    const live = devices?.get(key) ?? null;
    // No entry for this platform and this answer is superseded: a later read
    // may have declared the device gone (the map is emptied, not marked) —
    // this older answer must not bring it back.
    if (!live && superseded) continue;
    // A frame for THIS platform landed meanwhile (or a later read wrote it):
    // only a strictly newer answer may replace it.
    const thisLanded = live !== null && overtaken(key, live);
    if (live && thisLanded && !(at !== null && live.at !== null && at > live.at)) continue;
    // The same gate the socket path applies: a REST mirror of the pre-park
    // frame (same timestamp) must not resurrect a dead stream URL, and an
    // older answer never wins.
    if (live && isNotNewerThanCached(at, live)) continue;
    const target = devicesOf(workspaceId);
    target.set(key, {
      sessionId: context.sessionId,
      status,
      at,
      origin: "rest",
      restIssue: issue,
      parked: false,
    });
    if (key !== "unknown") target.delete("unknown");
    applied = true;
  }
  // A per-platform mirror is the platform's COMPLETE list: a cached device it
  // no longer names was removed — unless a frame for that platform landed
  // meanwhile (the platform's later word about it). The single-status shape
  // of an older platform says nothing about other platforms and prunes none.
  let pruned = false;
  const held = cloudSimulators.get(workspaceId);
  if (Array.isArray(detail.simulators) && !superseded && held) {
    const named = new Set(statuses.map(platformKey));
    for (const [key, entry] of [...held]) {
      if (named.has(key) || overtaken(key, entry)) continue;
      held.delete(key);
      pruned = true;
    }
    if (held.size === 0) {
      cloudSimulators.delete(workspaceId);
      broadcastCloudSimulator({ ...source, kind: "gone", data: {} });
      return null;
    }
  }
  if (!applied && !pruned) return primaryOf(cloudSimulators.get(workspaceId))?.status ?? null;
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
  /** The platform's clock when it answered (ISO). */
  timestamp?: string;
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
    // The platform's clock on the answer: a screenshot request tells the
    // capture it asked for from an older one by this stamp.
    ...(typeof data.timestamp === "string" ? { timestamp: data.timestamp } : {}),
  };
}
