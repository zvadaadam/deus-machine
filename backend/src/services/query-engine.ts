// backend/src/services/query-engine.ts
// Deus Query engine — handles q:* protocol frames for typed reactive queries.
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
} from "../db";
import { getConnection, broadcast } from "./ws.service";
import { broadcastWorkspacesAndStats } from "./dashboard-broadcast";
import type {
  QueryResource,
  QServerFrame,
} from "../../../shared/types/query-protocol";

// ---- Subscription State ----

interface Sub {
  id: string;
  resource: QueryResource;
  params: Record<string, unknown>;
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
export function handleFrame(connectionId: string, msg: Record<string, unknown>): void {
  const type = msg.type as string;

  match(type)
    .with("q:request", () => {
      handleRequest(connectionId, msg);
    })
    .with("q:subscribe", () => {
      handleSubscribe(connectionId, msg);
    })
    .with("q:unsubscribe", () => {
      handleUnsubscribe(connectionId, msg);
    })
    .with("q:mutate", () => {
      handleMutate(connectionId, msg);
    })
    .otherwise(() => {
      sendFrame(connectionId, {
        type: "q:error",
        id: (msg.id as string) ?? "unknown",
        code: "UNKNOWN_FRAME",
        message: `Unknown query frame type: ${type}`,
      });
    });
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
export function invalidate(resources: string[]): void {
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
  const broadcastResources = resources.filter(r => r !== "messages") as QueryResource[];
  if (broadcastResources.length > 0) {
    broadcast(JSON.stringify({
      type: "q:invalidate",
      resources: broadcastResources,
    } satisfies QServerFrame));
  }
}

// ---- Frame Handlers ----

function handleRequest(connectionId: string, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  const resource = msg.resource as QueryResource;
  const params = (msg.params as Record<string, unknown>) ?? {};

  try {
    const data = runQuery(resource, params);
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

function handleSubscribe(connectionId: string, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  const resource = msg.resource as QueryResource;
  const params = (msg.params as Record<string, unknown>) ?? {};

  // Send initial snapshot — only register subscription if query succeeds
  // (avoids zombie subscriptions when runQuery throws on invalid params)
  try {
    const data = runQuery(resource, params);

    // Get or create subscription map for this connection
    let connSubs = subs.get(connectionId);
    if (!connSubs) {
      connSubs = new Map();
      subs.set(connectionId, connSubs);
    }

    // Store subscription by client-assigned ID (replaces if same ID reused on reconnect)
    connSubs.set(id, { id, resource, params });

    // For messages: initialize cursor to current max seq
    if (resource === "messages" && params.sessionId) {
      const cursorKey = `${connectionId}:${id}`;
      try {
        const db = getDatabase();
        const row = db.prepare(
          "SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE session_id = ?"
        ).get(params.sessionId as string) as { max_seq: number } | undefined;
        messageCursors.set(cursorKey, row?.max_seq ?? 0);
      } catch {
        messageCursors.set(cursorKey, 0);
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

function handleUnsubscribe(connectionId: string, msg: Record<string, unknown>): void {
  const id = msg.id as string;

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

function handleMutate(connectionId: string, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  // Client sends `action`, not `mutation`
  const action = msg.action as string;
  const params = (msg.params as Record<string, unknown>) ?? {};

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

function runQuery(resource: string, params: Record<string, unknown>): unknown {
  const db = getDatabase();

  return match(resource)
    .with("workspaces", () => getDashboardWorkspaces(db))
    .with("stats", () => getStats(db))
    .with("sessions", () => {
      const workspaceId = params.workspaceId as string;
      if (!workspaceId) throw new Error("sessions requires workspaceId param");
      return getSessionsByWorkspaceId(db, workspaceId);
    })
    .with("messages", () => {
      const sessionId = params.sessionId as string;
      if (!sessionId) throw new Error("messages requires sessionId param");

      const rows = getMessages(db, sessionId, {
        limit: (params.limit as number) || 50,
        before: params.before as number | undefined,
        after: params.after as number | undefined,
      });

      const hasOlder = rows.length > 0
        ? hasOlderMessages(db, sessionId, rows[0].seq)
        : false;
      const hasNewer = rows.length > 0
        ? hasNewerMessages(db, sessionId, rows[rows.length - 1].seq)
        : false;

      return { messages: rows, hasOlder, hasNewer };
    })
    .otherwise(() => {
      throw new Error(`Unknown resource: ${resource}`);
    });
}

// ---- Mutation Dispatch ----

function runMutation(action: string, params: Record<string, unknown>): unknown {
  return match(action)
    .with("sendMessage", () => {
      // Lazy import to avoid circular dependency with relay.service.ts
      const { writeUserMessage } = require("./relay.service") as typeof import("./relay.service");
      const result = writeUserMessage(
        params.sessionId as string,
        params.content as string,
        params.model as string | undefined,
      );
      if (!result.success) throw new Error((result as any).error);
      // Client expects { messageId, seq } — get seq from the inserted message
      const db = getDatabase();
      const row = db.prepare(
        "SELECT seq FROM messages WHERE id = ?"
      ).get((result as any).messageId) as { seq: number } | undefined;
      return { messageId: (result as any).messageId, seq: row?.seq ?? 0 };
    })
    .with("archiveWorkspace", () => {
      const db = getDatabase();
      const workspaceId = params.workspaceId as string;
      if (!workspaceId) throw new Error("archiveWorkspace requires workspaceId");

      const workspace = getWorkspaceRaw(db, workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
      broadcastWorkspacesAndStats();
      invalidate(["workspaces", "stats"]);
      return { success: true };
    })
    .with("updateWorkspaceTitle", () => {
      const db = getDatabase();
      const workspaceId = params.workspaceId as string;
      const title = params.title as string;
      if (!workspaceId || title === undefined) throw new Error("updateWorkspaceTitle requires workspaceId and title");

      const workspace = getWorkspaceRaw(db, workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      db.prepare("UPDATE workspaces SET title = ? WHERE id = ?").run(title, workspaceId);
      broadcastWorkspacesAndStats();
      invalidate(["workspaces"]);
      return { success: true };
    })
    .otherwise(() => {
      throw new Error(`Unknown mutation: ${action}`);
    });
}

// ---- Message Delta Push ----

function pushMessageDelta(connectionId: string, subId: string, params: Record<string, unknown>): void {
  const sessionId = params.sessionId as string;
  if (!sessionId) return;

  const cursorKey = `${connectionId}:${subId}`;
  const lastSeq = messageCursors.get(cursorKey) ?? 0;

  try {
    const db = getDatabase();
    const newMessages = db.prepare(`
      SELECT id, session_id, seq, role, content, turn_id, model,
             agent_message_id, sent_at, cancelled_at, parent_tool_use_id
      FROM messages
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
    `).all(sessionId, lastSeq) as Array<{ seq: number; [key: string]: unknown }>;

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
