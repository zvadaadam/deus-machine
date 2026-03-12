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
  getMessages,
  hasOlderMessages,
  hasNewerMessages,
  getWorkspaceRaw,
  getMaxMessageSeq,
  getMessagesDelta,
  resetStatsCache,
} from "../db";
import { writeUserMessage } from "./message-writer";
import { getConnection, broadcast } from "./ws.service";
import {
  QUERY_RESOURCES,
  MUTATION_NAMES,
  type MutationName,
  type QueryResource,
  type QServerFrame,
} from "../../../shared/types/query-protocol";

// ---- Subscription State ----

type QueryParams = Record<string, unknown>;

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

/**
 * Push-first invalidation: re-run queries for active subscribers and push
 * fresh snapshots, then broadcast q:invalidate as fallback for unmounted caches.
 *
 * Messages are special: they use q:delta (cursor-based) instead of full snapshots,
 * and are excluded from the q:invalidate broadcast.
 */
export function invalidate(resources: QueryResource[]): void {
  if (resources.includes("stats")) {
    resetStatsCache();
  }

  // Phase 1: Push fresh data to active subscribers
  for (const [connectionId, connSubs] of subs) {
    if (!getConnection(connectionId)) {
      removeSubs(connectionId);
      continue;
    }

    for (const [subId, sub] of connSubs) {
      if (!resources.includes(sub.resource)) continue;

      if (sub.resource === "messages") {
        // Messages: push delta (new messages since last cursor)
        pushMessageDelta(connectionId, subId, sub.params);
      } else {
        // Other resources: push full snapshot
        try {
          const data = runQuery(sub.resource, sub.params);
          sendFrame(connectionId, {
            type: "q:snapshot",
            id: subId,
            data,
          });
        } catch (err) {
          console.error(`[QueryEngine] Snapshot push failed for ${sub.resource}:`, err);
        }
      }
    }
  }

  // Phase 2: Broadcast q:invalidate for unmounted caches (exclude messages)
  const broadcastResources = resources.filter(r => r !== "messages");
  if (broadcastResources.length > 0) {
    broadcast(
      JSON.stringify({
        type: "q:invalidate",
        resources: broadcastResources,
      } satisfies QServerFrame)
    );
  }

  // Phase 3: Emit stdout signal for Rust → Tauri event relay (desktop only).
  // Messages excluded: desktop gets session:message Tauri events directly from sidecar.
  // Suppressed in test environments to avoid polluting test output.
  if (process.env.NODE_ENV !== "test") {
    const tauriResources = resources.filter(r => r !== "messages");
    if (tauriResources.length > 0) {
      process.stdout.write(`OPENDEVS_INVALIDATE:${JSON.stringify({ resources: tauriResources })}\n`);
    }
  }
}

// ---- Frame Handlers ----

function handleRequest(connectionId: string, msg: ResourceFrameInput): void {
  const { id, resource, params } = msg;

  try {
    const typedResource = toQueryResource(resource);
    const data = runQuery(typedResource, params);
    sendFrame(connectionId, { type: "q:response", id, data });
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

  // Send initial snapshot — only register subscription if query succeeds
  // (avoids zombie subscriptions when runQuery throws on invalid params)
  try {
    const data = runQuery(typedResource, params);

    // Get or create subscription map for this connection
    let connSubs = subs.get(connectionId);
    if (!connSubs) {
      connSubs = new Map();
      subs.set(connectionId, connSubs);
    }

    // Store subscription by client-assigned ID (replaces if same ID reused on reconnect)
    connSubs.set(id, { id, resource: typedResource, params });

    // For messages: initialize cursor to current max seq
    if (typedResource === "messages") {
      const sessionId = readStringParam(params, "sessionId");
      const cursorKey = `${connectionId}:${id}`;
      if (sessionId) {
        try {
          const db = getDatabase();
          messageCursors.set(cursorKey, getMaxMessageSeq(db, sessionId));
        } catch {
          messageCursors.set(cursorKey, 0);
        }
      }
    }

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

function handleMutate(connectionId: string, msg: MutateFrameInput): void {
  const { id, action, params } = msg;

  try {
    const result = runMutation(action, params);
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

// ---- Query Dispatch ----

function runQuery(resource: QueryResource, params: QueryParams): unknown {
  const db = getDatabase();

  return match(resource)
    .with("workspaces", () => getDashboardWorkspaces(db))
    .with("stats", () => getStats(db))
    .with("sessions", () => {
      const workspaceId = readStringParam(params, "workspaceId");
      if (!workspaceId) throw new Error("sessions requires workspaceId param");
      return getSessionsByWorkspaceId(db, workspaceId);
    })
    .with("messages", () => {
      const sessionId = readStringParam(params, "sessionId");
      if (!sessionId) throw new Error("messages requires sessionId param");

      const rows = getMessages(db, sessionId, {
        limit: readNumberParam(params, "limit") ?? 50,
        before: readNumberParam(params, "before"),
        after: readNumberParam(params, "after"),
      });

      const hasOlder = rows.length > 0 ? hasOlderMessages(db, sessionId, rows[0].seq) : false;
      const hasNewer = rows.length > 0
        ? hasNewerMessages(db, sessionId, rows[rows.length - 1].seq)
        : false;

      return { messages: rows, hasOlder, hasNewer };
    })
    .exhaustive();
}

// ---- Mutation Dispatch ----

function runMutation(action: string, params: QueryParams): unknown {
  const typedAction = toMutationName(action);

  return match(typedAction)
    .with("sendMessage", () => {
      const sessionId = readStringParam(params, "sessionId");
      const content = readStringParam(params, "content");
      const model = readStringParam(params, "model");
      if (!sessionId || !content) {
        throw new Error("sendMessage requires sessionId and content");
      }

      const result = writeUserMessage(sessionId, content, model);
      if (!result.success) throw new Error(result.error);
      invalidate(["workspaces", "sessions", "messages", "stats"]);
      // Client expects { messageId, seq } — get seq from the inserted message
      const db = getDatabase();
      const row = db.prepare("SELECT seq FROM messages WHERE id = ?").get(result.messageId) as
        | { seq: number }
        | undefined;
      return { messageId: result.messageId, seq: row?.seq ?? 0 };
    })
    .with("archiveWorkspace", () => {
      const db = getDatabase();
      const workspaceId = readStringParam(params, "workspaceId");
      if (!workspaceId) throw new Error("archiveWorkspace requires workspaceId");

      const workspace = getWorkspaceRaw(db, workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
      invalidate(["workspaces", "stats"]);
      return { success: true };
    })
    .with("updateWorkspaceTitle", () => {
      const db = getDatabase();
      const workspaceId = readStringParam(params, "workspaceId");
      const title = readStringParam(params, "title");
      if (!workspaceId || title === undefined) {
        throw new Error("updateWorkspaceTitle requires workspaceId and title");
      }

      const workspace = getWorkspaceRaw(db, workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      db.prepare("UPDATE workspaces SET title = ? WHERE id = ?").run(title, workspaceId);
      invalidate(["workspaces"]);
      return { success: true };
    })
    .exhaustive();
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
      upserted: newMessages,
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

function readStringParam(params: QueryParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberParam(params: QueryParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
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
