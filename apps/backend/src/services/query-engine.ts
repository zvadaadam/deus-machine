// backend/src/services/query-engine.ts
// Query engine — handles q:* protocol frames for typed reactive queries.
// Module singleton: subscription state + dispatch logic.
// Works for both local WS and relay-tunneled connections via WsSendable.
//
// Subscription model: ID-keyed. Client assigns IDs ("sub_1", "sub_2") and
// server echoes them back on q:snapshot/q:delta so the client can route
// to the correct callback.

import { match } from "ts-pattern";
import { getDatabase } from "../lib/database";
import {
  getDashboardWorkspaces,
  getStats,
  getSessionsByWorkspaceId,
  getSessionById,
  getMessages,
  hasOlderMessages,
  getWorkspaceRaw,
  getMaxMessageSeq,
  getMessagesDelta,
  resetStatsCache,
  getWorkspacesByRepo,
  getWorkspacesBySessionIds,
  getAllRepositorySummaries,
  attachParts,
} from "../db";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { getConnection } from "./ws.service";
import { resolveToolRelay, rejectToolRelay, runCommand } from "./agent";
import { delegateToRoute } from "./route-delegate";
import { autoProgressStatus, setWorkspaceStatus } from "./workspace-status.service";
import { getRunningApps, listApps, stopAppsForWorkspace } from "./aap";
import { WorkspaceStatusSchema } from "@shared/enums";
import {
  QUERY_RESOURCES,
  REQUEST_RESOURCES,
  MUTATION_NAMES,
  COMMAND_NAMES,
  type MutationName,
  type CommandName,
  type QueryResource,
  type RequestResource,
  type QServerFrame,
} from "@shared/types/query-protocol";
import {
  type QueryParams,
  readStringParam,
  readNumberParam,
  requireParam,
} from "../lib/query-params";
import { groupWorkspacesByRepo } from "../lib/workspace-grouping";

// ---- Subscription State ----

interface ResourceFrameInput {
  id: string;
  resource: string;
  params: QueryParams;
}

interface UnsubscribeFrameInput {
  id: string;
}

interface MutateFrameInput {
  id: string;
  action: string;
  params: QueryParams;
}

interface CommandFrameInput {
  id: string;
  command: string;
  params: QueryParams;
}

interface Sub {
  id: string;
  resource: QueryResource;
  params: QueryParams;
}

/** Per-connection active subscriptions, keyed by client-assigned sub ID. */
const subs = new Map<string, Map<string, Sub>>();

/** For messages: track last seen seq per subscription for delta push.
 *  Key: `${connectionId}:${subId}` → lastSeq */
const messageCursors = new Map<string, number>();

// ---- Public API ----

/**
 * Handle an incoming q:* frame from an authenticated connection.
 * Registered as onQueryFrame in ws.service protocol handlers.
 */
export function handleFrame(connectionId: string, msg: QueryParams): void {
  const type = typeof msg.type === "string" ? msg.type : "unknown";

  try {
    match(type)
      .with("q:request", () => {
        handleRequest(connectionId, parseResourceFrame(msg));
      })
      .with("q:subscribe", () => {
        handleSubscribe(connectionId, parseResourceFrame(msg));
      })
      .with("q:unsubscribe", () => {
        handleUnsubscribe(connectionId, parseUnsubscribeFrame(msg));
      })
      .with("q:mutate", () => {
        handleMutate(connectionId, parseMutateFrame(msg));
      })
      .with("q:command", () => {
        handleCommand(connectionId, parseCommandFrame(msg));
      })
      .with("q:tool_response", () => {
        handleToolResponse(msg);
      })
      .otherwise(() => {
        sendFrame(connectionId, {
          type: "q:error",
          id: getFrameId(msg),
          code: "UNKNOWN_FRAME",
          message: `Unknown query frame type: ${type}`,
        });
      });
  } catch (err) {
    sendFrame(connectionId, {
      type: "q:error",
      id: getFrameId(msg),
      code: "INVALID_FRAME",
      message: err instanceof Error ? err.message : "Invalid query frame",
    });
  }
}

/** Remove all subscriptions for a connection (cleanup on disconnect). */
export function removeSubs(connectionId: string): void {
  const connSubs = subs.get(connectionId);
  if (connSubs) {
    for (const [subId, sub] of connSubs) {
      if (sub.resource === "messages") {
        messageCursors.delete(`${connectionId}:${subId}`);
      }
    }
    subs.delete(connectionId);
  }
}

/** Optional context for targeted invalidation (e.g., which sessions changed). */
interface InvalidateContext {
  sessionIds?: string[];
}

/**
 * Push-first invalidation: re-run queries for active subscribers and push
 * fresh snapshots or deltas.
 *
 * Messages use q:delta (cursor-based) instead of full snapshots.
 * When `ctx.sessionIds` is provided, workspace subscribers receive a targeted
 * q:delta (only the changed workspaces) instead of a full q:snapshot.
 */
export function invalidate(resources: QueryResource[], ctx?: InvalidateContext): void {
  if (resources.includes("stats")) {
    resetStatsCache();
  }

  for (const [connectionId, connSubs] of subs) {
    if (!getConnection(connectionId)) {
      removeSubs(connectionId);
      continue;
    }

    for (const [subId, sub] of connSubs) {
      if (!resources.includes(sub.resource)) continue;

      if (sub.resource === "messages") {
        pushMessageDelta(connectionId, subId, sub.params);
        continue;
      }

      // Session with context: only push if this subscription's session changed
      if (sub.resource === "session" && ctx?.sessionIds?.length) {
        const sid = readStringParam(sub.params, "sessionId");
        if (!sid || !ctx.sessionIds.includes(sid)) continue;
      }

      // Workspaces with session context: try targeted delta first
      if (sub.resource === "workspaces" && ctx?.sessionIds?.length) {
        if (pushWorkspaceDelta(connectionId, subId, sub, ctx.sessionIds)) continue;
      }

      pushSnapshot(connectionId, subId, sub);
    }
  }
}

/** Try a targeted workspace delta; return true if pushed, false to fall back to snapshot. */
function pushWorkspaceDelta(
  connectionId: string,
  subId: string,
  sub: Sub,
  sessionIds: string[]
): boolean {
  try {
    const db = getDatabase();
    const stateFilter = readStringParam(sub.params, "state") ?? "ready,initializing";
    const allowedStates = new Set(stateFilter.split(",").map((s) => s.trim()));
    const changed = getWorkspacesBySessionIds(db, sessionIds).filter((ws) =>
      allowedStates.has(ws.state)
    );
    if (changed.length === 0) return false;

    sendFrame(connectionId, {
      type: "q:delta",
      id: subId,
      upserted: changed.map((ws) => ({ ...ws, workspace_path: computeWorkspacePath(ws) })),
    });
    return true;
  } catch (err) {
    console.error(`[QueryEngine] Workspace delta failed, falling back to snapshot:`, err);
    return false;
  }
}

/** Push a full snapshot for a subscription; log and swallow errors. */
function pushSnapshot(connectionId: string, subId: string, sub: Sub): void {
  try {
    const data = runQuery(sub.resource, sub.params);
    sendFrame(connectionId, { type: "q:snapshot", id: subId, data });
  } catch (err) {
    console.error(`[QueryEngine] Snapshot push failed for ${sub.resource}:`, err);
  }
}

// ---- Frame Handlers ----

async function handleRequest(connectionId: string, msg: ResourceFrameInput): Promise<void> {
  const { id, resource, params } = msg;

  try {
    // Try subscribable resource first, then request-only resource
    if (isQueryResource(resource)) {
      const data = runQuery(resource, params);
      sendFrame(connectionId, { type: "q:response", id, data });
    } else if (isRequestResource(resource)) {
      const data = await runRequest(resource, params);
      sendFrame(connectionId, { type: "q:response", id, data });
    } else {
      throw new Error(`Unknown resource: ${resource}`);
    }
  } catch (err) {
    sendFrame(connectionId, {
      type: "q:error",
      id,
      code: "QUERY_ERROR",
      message: err instanceof Error ? err.message : "Query failed",
    });
  }
}

function handleSubscribe(connectionId: string, msg: ResourceFrameInput): void {
  const { id, resource, params } = msg;

  // Validate resource upfront — fail fast before running query
  const typedResource = toQueryResource(resource);

  try {
    // Register subscription (shared for all resource types)
    let connSubs = subs.get(connectionId);
    if (!connSubs) {
      connSubs = new Map();
      subs.set(connectionId, connSubs);
    }
    connSubs.set(id, { id, resource: typedResource, params });

    // Messages: delta-only subscription. Clients load history via q:request
    // (or HTTP on web); WS only pushes NEW messages via q:delta. See the
    // doc comment on QSubscribeFrame.
    if (typedResource === "messages") {
      const sessionId = readStringParam(params, "sessionId");

      // Initialize cursor to current max seq — only NEW messages get pushed via delta
      const cursorKey = `${connectionId}:${id}`;
      let cursor = 0;
      if (sessionId) {
        try {
          const db = getDatabase();
          cursor = getMaxMessageSeq(db, sessionId);
        } catch {
          cursor = 0;
        }
        messageCursors.set(cursorKey, cursor);
      }

      sendFrame(connectionId, { type: "q:subscribed", id, cursor });
      return;
    }

    // All other resources: send initial snapshot
    const data = runQuery(typedResource, params);
    sendFrame(connectionId, { type: "q:snapshot", id, data });
  } catch (err) {
    sendFrame(connectionId, {
      type: "q:error",
      id,
      code: "SUBSCRIBE_ERROR",
      message: err instanceof Error ? err.message : "Subscribe failed",
    });
  }
}

function handleUnsubscribe(connectionId: string, msg: UnsubscribeFrameInput): void {
  const { id } = msg;

  const connSubs = subs.get(connectionId);
  if (!connSubs) return;

  const sub = connSubs.get(id);
  if (sub) {
    // Clean up message cursor
    if (sub.resource === "messages") {
      messageCursors.delete(`${connectionId}:${id}`);
    }
    connSubs.delete(id);
    if (connSubs.size === 0) subs.delete(connectionId);
  }
}

async function handleMutate(connectionId: string, msg: MutateFrameInput): Promise<void> {
  const { id, action, params } = msg;

  try {
    const result = await runMutation(action, params);
    sendFrame(connectionId, {
      type: "q:mutate_result",
      id,
      success: true,
      data: result,
    });
  } catch (err) {
    sendFrame(connectionId, {
      type: "q:mutate_result",
      id,
      success: false,
      error: err instanceof Error ? err.message : "Mutation failed",
    });
  }
}

async function handleCommand(connectionId: string, msg: CommandFrameInput): Promise<void> {
  const { id, command, params } = msg;

  try {
    const result = await runCommand(toCommandName(command), params);
    sendFrame(connectionId, {
      type: "q:command_ack",
      id,
      accepted: true,
      ...result,
    } satisfies QServerFrame);
  } catch (err) {
    sendFrame(connectionId, {
      type: "q:command_ack",
      id,
      accepted: false,
      error: err instanceof Error ? err.message : "Command failed",
    } satisfies QServerFrame);
  }
}

// ---- Tool Response Handler ----

function handleToolResponse(msg: QueryParams): void {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
  if (!requestId) {
    console.error("[QueryEngine] q:tool_response missing requestId");
    return;
  }

  if ("error" in msg && msg.error !== undefined) {
    const errorStr = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error);
    const resolved = rejectToolRelay(requestId, errorStr);
    if (!resolved) {
      console.warn(`[QueryEngine] q:tool_response for unknown requestId=${requestId} (error)`);
    }
  } else {
    const resolved = resolveToolRelay(requestId, msg.result);
    if (!resolved) {
      console.warn(`[QueryEngine] q:tool_response for unknown requestId=${requestId} (result)`);
    }
  }
}

// ---- Query Dispatch ----

function runQuery(resource: QueryResource, params: QueryParams): unknown {
  const db = getDatabase();

  return (
    match(resource)
      .with("workspaces", () => {
        const state = readStringParam(params, "state") ?? "ready,initializing";
        return groupWorkspacesByRepo(getWorkspacesByRepo(db, state), getAllRepositorySummaries(db));
      })
      .with("stats", () => getStats(db))
      .with("sessions", () =>
        getSessionsByWorkspaceId(db, requireParam(params, "workspaceId", "sessions"))
      )
      .with("session", () => getSessionById(db, requireParam(params, "sessionId", "session")))
      .with("messages", () => {
        const sessionId = requireParam(params, "sessionId", "messages");
        const before = readNumberParam(params, "before");

        const rows = getMessages(db, sessionId, {
          limit: readNumberParam(params, "limit") ?? 2000,
          before,
        });

        const hasOlder = rows.length > 0 ? hasOlderMessages(db, sessionId, rows[0].seq) : false;

        return { messages: attachParts(db, rows), has_older: hasOlder, has_newer: false };
      })
      // AAP (agentic apps protocol) — real handlers. `apps` is the registry;
      // `running_apps` is workspace-scoped live instances.
      .with("apps", () => listApps())
      .with("running_apps", () => {
        const workspaceId = readStringParam(params, "workspaceId");
        return getRunningApps(workspaceId ?? null);
      })
      .exhaustive()
  );
}

// ---- Request Dispatch (one-shot reads via route delegation) ----

type RequestResourceName = (typeof REQUEST_RESOURCES)[number];

function isRequestResource(value: string): value is RequestResourceName {
  return (REQUEST_RESOURCES as readonly string[]).includes(value);
}

/**
 * Route one-shot request resources to existing Hono endpoints.
 * Uses delegateToRoute() so all business logic stays in the route handlers.
 */
async function runRequest(resource: RequestResourceName, params: QueryParams): Promise<unknown> {
  /** GET /api/workspaces/:id{path} — covers the 10+ workspace-scoped reads. */
  const wsGet = (path = "") =>
    delegateToRoute(
      "GET",
      `/api/workspaces/${encodeURIComponent(requireParam(params, "workspaceId", resource))}${path}`
    );
  /** GET /api/repos/:id{path} — covers repo-scoped reads. */
  const repoGet = (path = "") =>
    delegateToRoute(
      "GET",
      `/api/repos/${encodeURIComponent(requireParam(params, "repoId", resource))}${path}`
    );

  return match(resource)
    .with("settings", () => delegateToRoute("GET", "/api/settings"))
    .with("repos", () => delegateToRoute("GET", "/api/repos"))
    .with("repoManifest", () => repoGet("/manifest"))
    .with("detectManifest", () => repoGet("/detect-manifest"))
    .with("agentConfig", () => {
      const section = readStringParam(params, "section") ?? "agents";
      const scope = readStringParam(params, "scope") ?? "global";
      const repoPath = readStringParam(params, "repoPath");
      const qs = new URLSearchParams({ scope });
      if (repoPath) qs.set("repoPath", repoPath);
      return delegateToRoute(
        "GET",
        `/api/agent-config/${encodeURIComponent(section)}?${qs.toString()}`
      );
    })
    .with("ghStatus", () => delegateToRoute("GET", "/api/gh-status"))
    .with("prStatus", () => wsGet("/pr-status"))
    .with("workspace", () => wsGet())
    .with("allWorkspaces", () => delegateToRoute("GET", "/api/workspaces"))
    .with("workspaceManifest", () => wsGet("/manifest"))
    .with("setupLogs", () => wsGet("/setup-logs"))
    .with("diffStats", () => wsGet("/diff-stats"))
    .with("diffFiles", () => wsGet("/diff-files"))
    .with("diffFile", () => {
      const wsId = requireParam(params, "workspaceId", "diffFile");
      const file = requireParam(params, "file", "diffFile");
      return delegateToRoute(
        "GET",
        `/api/workspaces/${encodeURIComponent(wsId)}/diff-file?file=${encodeURIComponent(file)}`
      );
    })
    .with("penFiles", () => wsGet("/pen-files"))
    .with("workspaceFiles", () => wsGet("/files"))
    .with("fileContent", () => {
      const wsId = requireParam(params, "workspaceId", "fileContent");
      const filePath = requireParam(params, "path", "fileContent");
      return delegateToRoute(
        "GET",
        `/api/workspaces/${encodeURIComponent(wsId)}/file-content?path=${encodeURIComponent(filePath)}`
      );
    })
    .with("fileSearch", () => {
      const wsId = requireParam(params, "workspaceId", "fileSearch");
      const query = readStringParam(params, "query") ?? "";
      const limit = readNumberParam(params, "limit");
      return delegateToRoute("POST", `/api/workspaces/${encodeURIComponent(wsId)}/files/search`, {
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
    })
    .with("recentProjects", () => delegateToRoute("GET", "/api/onboarding/recent-projects"))
    .with("pairedDevices", () => delegateToRoute("GET", "/api/remote-auth/devices"))
    .with("relayStatus", () => delegateToRoute("GET", "/api/relay/status"))
    .with("allSessions", () => delegateToRoute("GET", "/api/sessions"))
    .with("repoPrs", () => repoGet("/prs"))
    .with("repoBranches", () => repoGet("/branches"))
    .with("agentAuth", () => delegateToRoute("GET", "/api/settings/agent-auth"))
    .exhaustive();
}

// ---- Mutation Dispatch ----

async function runMutation(action: string, params: QueryParams): Promise<unknown> {
  const typedAction = toMutationName(action);

  return (
    match(typedAction)
      .with("archiveWorkspace", async () => {
        const db = getDatabase();
        const workspaceId = requireParam(params, "workspaceId", "archiveWorkspace");

        const workspace = getWorkspaceRaw(db, workspaceId);
        if (!workspace) throw new Error("Workspace not found");

        // Stop AAP apps running in this workspace before we flip the archive
        // flag — orphan sweep on next boot would catch them otherwise, but
        // an explicit stop gives clients a clean status transition in the UI
        // and frees the port immediately. Capped at 2s so a slow-to-exit
        // child can't make the Archive button hang; any survivor is caught
        // by the next boot's orphan sweep. Errors are swallowed for the
        // same reason — the archive must succeed even if a child crash
        // races with our SIGTERM.
        const ARCHIVE_STOP_CEILING_MS = 2_000;
        await Promise.race([
          stopAppsForWorkspace(workspaceId).catch((err) => {
            console.warn(
              `[QueryEngine] stopAppsForWorkspace failed during archive workspaceId=${workspaceId}`,
              err
            );
          }),
          new Promise<void>((resolve) => setTimeout(resolve, ARCHIVE_STOP_CEILING_MS)),
        ]);

        db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
        autoProgressStatus(workspaceId, "done", { force: true });
        invalidate(["workspaces", "stats"]);
        return { success: true };
      })
      .with("updateWorkspaceTitle", () => {
        const db = getDatabase();
        const workspaceId = requireParam(params, "workspaceId", "updateWorkspaceTitle");
        const title = readStringParam(params, "title");
        if (title === undefined) throw new Error("updateWorkspaceTitle requires title");

        const workspace = getWorkspaceRaw(db, workspaceId);
        if (!workspace) throw new Error("Workspace not found");

        db.prepare("UPDATE workspaces SET title = ? WHERE id = ?").run(title, workspaceId);
        invalidate(["workspaces"]);
        return { success: true };
      })
      // ---- New mutations delegated to existing routes ----
      .with("updateWorkspace", () => {
        const workspaceId = requireParam(params, "workspaceId", "updateWorkspace");
        const { workspaceId: _, ...body } = params;
        return delegateToRoute("PATCH", `/api/workspaces/${encodeURIComponent(workspaceId)}`, body);
      })
      .with("createSession", () => {
        const wsId = requireParam(params, "workspaceId", "createSession");
        return delegateToRoute("POST", `/api/workspaces/${encodeURIComponent(wsId)}/sessions`);
      })
      .with("addRepo", () => {
        const rootPath = requireParam(params, "root_path", "addRepo");
        return delegateToRoute("POST", "/api/repos", { root_path: rootPath });
      })
      .with("saveRepoManifest", () => {
        const repoId = requireParam(params, "repoId", "saveRepoManifest");
        const { repoId: _, ...manifest } = params;
        return delegateToRoute(
          "POST",
          `/api/repos/${encodeURIComponent(repoId)}/manifest`,
          manifest
        );
      })
      .with("saveAgentConfig", () => {
        const section = readStringParam(params, "section") ?? "agents";
        const scope = readStringParam(params, "scope") ?? "global";
        const repoPath = readStringParam(params, "repoPath");
        const qs = new URLSearchParams({ scope });
        if (repoPath) qs.set("repoPath", repoPath);
        const { section: _, scope: _s, repoPath: _r, ...body } = params;
        return delegateToRoute(
          "POST",
          `/api/agent-config/${encodeURIComponent(section)}?${qs.toString()}`,
          body
        );
      })
      .with("deleteAgentConfig", () => {
        const section = readStringParam(params, "section") ?? "agents";
        const itemId = requireParam(params, "itemId", "deleteAgentConfig");
        const scope = readStringParam(params, "scope") ?? "global";
        const repoPath = readStringParam(params, "repoPath");
        const qs = new URLSearchParams({ scope });
        if (repoPath) qs.set("repoPath", repoPath);
        return delegateToRoute(
          "DELETE",
          `/api/agent-config/${encodeURIComponent(section)}/${encodeURIComponent(itemId)}?${qs.toString()}`
        );
      })
      .with("saveSetting", () => {
        const key = requireParam(params, "key", "saveSetting");
        return delegateToRoute("POST", "/api/settings", { key, value: params.value });
      })
      .with("invalidateFileCache", () => {
        const wsId = requireParam(params, "workspaceId", "invalidateFileCache");
        return delegateToRoute(
          "POST",
          `/api/workspaces/${encodeURIComponent(wsId)}/files/invalidate-cache`
        );
      })
      .with("runTask", () => {
        const wsId = requireParam(params, "workspaceId", "runTask");
        const taskName = requireParam(params, "taskName", "runTask");
        return delegateToRoute(
          "POST",
          `/api/workspaces/${encodeURIComponent(wsId)}/tasks/${encodeURIComponent(taskName)}/run`
        );
      })
      .with("revokeDevice", () => {
        const deviceId = requireParam(params, "deviceId", "revokeDevice");
        return delegateToRoute(
          "DELETE",
          `/api/remote-auth/devices/${encodeURIComponent(deviceId)}`
        );
      })
      .with("updateWorkspaceStatus", () => {
        const workspaceId = requireParam(params, "workspaceId", "updateWorkspaceStatus");
        const status = requireParam(params, "status", "updateWorkspaceStatus");
        const parsed = WorkspaceStatusSchema.parse(status);
        setWorkspaceStatus(workspaceId, parsed);
        invalidate(["workspaces", "stats"]);
        return { success: true };
      })
      .exhaustive()
  );
}

// ---- Message Delta Push ----

function pushMessageDelta(connectionId: string, subId: string, params: QueryParams): void {
  const sessionId = readStringParam(params, "sessionId");
  if (!sessionId) return;

  const cursorKey = `${connectionId}:${subId}`;
  const lastSeq = messageCursors.get(cursorKey) ?? 0;

  try {
    const db = getDatabase();
    const newMessages = getMessagesDelta(db, sessionId, lastSeq);

    if (newMessages.length === 0) return;

    const maxSeq = newMessages[newMessages.length - 1].seq;
    messageCursors.set(cursorKey, maxSeq);

    sendFrame(connectionId, {
      type: "q:delta",
      id: subId,
      upserted: attachParts(db, newMessages),
      cursor: maxSeq,
    });
  } catch (err) {
    console.error(`[QueryEngine] Message delta push failed:`, err);
  }
}

// ---- Helpers ----

function sendFrame(connectionId: string, frame: QServerFrame): void {
  const conn = getConnection(connectionId);
  if (!conn) return;
  try {
    conn.ws.send(JSON.stringify(frame));
  } catch {
    // Connection may have closed
  }
}

function parseResourceFrame(msg: QueryParams): ResourceFrameInput {
  return {
    id: requireString(msg.id, "id"),
    resource: requireString(msg.resource, "resource"),
    params: getParams(msg.params),
  };
}

function parseUnsubscribeFrame(msg: QueryParams): UnsubscribeFrameInput {
  return {
    id: requireString(msg.id, "id"),
  };
}

function parseMutateFrame(msg: QueryParams): MutateFrameInput {
  return {
    id: requireString(msg.id, "id"),
    action: requireString(msg.action, "action"),
    params: getParams(msg.params),
  };
}

function getParams(value: unknown): QueryParams {
  if (value == null) return {};
  if (isRecord(value)) return value;
  throw new Error("Frame params must be an object");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Frame requires string ${field}`);
  }
  return value;
}

function getFrameId(msg: QueryParams): string {
  return typeof msg.id === "string" ? msg.id : "unknown";
}

function isRecord(value: unknown): value is QueryParams {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryResource(value: string): value is QueryResource {
  return (QUERY_RESOURCES as readonly string[]).includes(value);
}

function toQueryResource(value: string): QueryResource {
  if (!isQueryResource(value)) throw new Error(`Unknown resource: ${value}`);
  return value;
}

function isMutationName(value: string): value is MutationName {
  return (MUTATION_NAMES as readonly string[]).includes(value);
}

function toMutationName(value: string): MutationName {
  if (!isMutationName(value)) throw new Error(`Unknown mutation: ${value}`);
  return value;
}

function parseCommandFrame(msg: QueryParams): CommandFrameInput {
  return {
    id: requireString(msg.id, "id"),
    command: requireString(msg.command, "command"),
    params: getParams(msg.params),
  };
}

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

function toCommandName(value: string): CommandName {
  if (!isCommandName(value)) throw new Error(`Unknown command: ${value}`);
  return value;
}
