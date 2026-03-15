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
  hasNewerMessages,
  getWorkspaceRaw,
  getMaxMessageSeq,
  getMessagesDelta,
  resetStatsCache,
  getWorkspacesByRepo,
  getWorkspacesBySessionIds,
  getAllRepositorySummaries,
  getSessionRaw,
} from "../db";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { writeUserMessage } from "./message-writer";
import { persistSessionError } from "./agent-persistence";
import { getConnection } from "./ws.service";
import { resolve as resolveToolRelay, reject as rejectToolRelay } from "./tool-relay";
import {
  QUERY_RESOURCES,
  MUTATION_NAMES,
  COMMAND_NAMES,
  type MutationName,
  type CommandName,
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
      } else if (sub.resource === "workspaces" && ctx?.sessionIds?.length) {
        // Workspaces with session context: try targeted delta
        try {
          const db = getDatabase();
          const stateFilter = readStringParam(sub.params, "state") ?? "ready,initializing";
          const allowedStates = new Set(stateFilter.split(",").map(s => s.trim()));
          const changedWorkspaces = getWorkspacesBySessionIds(db, ctx.sessionIds)
            .filter(ws => allowedStates.has(ws.state));
          if (changedWorkspaces.length > 0) {
            const withPaths = changedWorkspaces.map(ws => ({
              ...ws,
              workspace_path: computeWorkspacePath(ws),
            }));
            sendFrame(connectionId, {
              type: "q:delta",
              id: subId,
              upserted: withPaths,
            });
          } else {
            // Session IDs didn't match any workspaces — fall back to full snapshot
            const data = runQuery(sub.resource, sub.params);
            sendFrame(connectionId, { type: "q:snapshot", id: subId, data });
          }
        } catch (err) {
          // Delta lookup failed — fall back to full snapshot
          console.error(`[QueryEngine] Workspace delta failed, falling back to snapshot:`, err);
          try {
            const data = runQuery(sub.resource, sub.params);
            sendFrame(connectionId, { type: "q:snapshot", id: subId, data });
          } catch (snapErr) {
            console.error(`[QueryEngine] Snapshot fallback also failed:`, snapErr);
          }
        }
      } else if (sub.resource === "session" && ctx?.sessionIds?.length) {
        // Session with context: only push if this subscription's session is in the changed set
        const subscribedSessionId = readStringParam(sub.params, "sessionId");
        if (subscribedSessionId && ctx.sessionIds.includes(subscribedSessionId)) {
          try {
            const data = runQuery(sub.resource, sub.params);
            sendFrame(connectionId, { type: "q:snapshot", id: subId, data });
          } catch (err) {
            console.error(`[QueryEngine] Session snapshot push failed:`, err);
          }
        }
        // If session not in changed set, skip the push
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

function handleCommand(connectionId: string, msg: CommandFrameInput): void {
  const { id, command, params } = msg;

  try {
    const result = runCommand(command, params);
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

// ---- Agent Forwarding ----

type ForwardToAgentFn = (params: {
  sessionId: string;
  agentType: string;
  prompt: string;
  options: Record<string, unknown>;
}) => Promise<{ accepted: boolean; reason?: string }>;

type CancelAgentFn = (params: { sessionId: string }) => Promise<void>;

let forwardToAgent: ForwardToAgentFn | null = null;
let cancelAgent: CancelAgentFn | null = null;

/** Register the agent client forwarding callbacks (called from server.ts) */
export function setAgentForwarder(forward: ForwardToAgentFn, cancel: CancelAgentFn): void {
  forwardToAgent = forward;
  cancelAgent = cancel;
}

// ---- Command Dispatch ----

function runCommand(command: string, params: QueryParams): { commandId?: string } {
  const typedCommand = toCommandName(command);

  return match(typedCommand)
    .with("sendMessage", () => {
      const sessionId = readStringParam(params, "sessionId");
      const content = readStringParam(params, "content");
      const model = readStringParam(params, "model");
      if (!sessionId || !content) {
        throw new Error("sendMessage requires sessionId and content");
      }

      const result = writeUserMessage(sessionId, content, model);
      if (!result.success) throw new Error(result.error);
      invalidate(["workspaces", "sessions", "session", "messages", "stats"], { sessionIds: [sessionId] });

      // Forward to agent-server to start the turn (fire-and-forget for responsiveness).
      // The ACK has already been sent, so handle rejection asynchronously by
      // persisting a session error — the frontend learns via WS subscription.
      if (forwardToAgent) {
        const agentType = readStringParam(params, "agentType") || "claude";
        forwardToAgent({
          sessionId,
          agentType,
          prompt: content,
          options: {
            cwd: readStringParam(params, "cwd") || "",
            model,
            maxThinkingTokens: params.maxThinkingTokens as number | undefined,
            maxTurns: params.maxTurns as number | undefined,
            turnId: readStringParam(params, "turnId"),
            permissionMode: readStringParam(params, "permissionMode"),
            claudeEnvVars: readStringParam(params, "claudeEnvVars"),
            ghToken: readStringParam(params, "ghToken"),
            opendevsEnv: params.opendevsEnv as Record<string, string> | undefined,
            additionalDirectories: params.additionalDirectories as string[] | undefined,
            chromeEnabled: params.chromeEnabled as boolean | undefined,
            strictDataPrivacy: params.strictDataPrivacy as boolean | undefined,
            shouldResetGenerator: params.shouldResetGenerator as boolean | undefined,
            resume: readStringParam(params, "resume"),
            resumeSessionAt: readStringParam(params, "resumeSessionAt"),
          },
        }).then((response) => {
          if (!response.accepted) {
            const reason = response.reason || "Agent rejected the message";
            console.error(`[QueryEngine] Agent rejected sendMessage for session=${sessionId}: ${reason}`);
            persistSessionError({
              type: "session.error",
              sessionId,
              agentType: agentType as "claude",
              error: reason,
              category: "agent",
            });
            invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
          }
        }).catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error("[QueryEngine] Failed to forward to agent-server:", errorMsg);
          persistSessionError({
            type: "session.error",
            sessionId,
            agentType: agentType as "claude",
            error: `Agent server communication failed: ${errorMsg}`,
            category: "agent",
          });
          invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
        });
      }

      return { commandId: result.messageId };
    })
    .with("stopSession", () => {
      const sessionId = readStringParam(params, "sessionId");
      if (!sessionId) throw new Error("stopSession requires sessionId");

      // Forward cancel to agent-server
      if (cancelAgent) {
        cancelAgent({ sessionId }).catch((err) => {
          console.error("[QueryEngine] Failed to cancel on agent-server:", err);
        });
      }

      const db = getDatabase();
      const session = getSessionRaw(db, sessionId);
      if (!session) throw new Error("Session not found");

      db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(sessionId);
      invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
      return {};
    })
    .exhaustive();
}

// ---- Query Dispatch ----

function runQuery(resource: QueryResource, params: QueryParams): unknown {
  const db = getDatabase();

  return match(resource)
    .with("workspaces", () => {
      // Return RepoGroup[] shape matching GET /workspaces/by-repo
      const state = readStringParam(params, "state") ?? "ready,initializing";
      const workspaces = getWorkspacesByRepo(db, state);

      const grouped: Record<string, { repo_id: string; repo_name: string; sort_order: number; workspaces: unknown[] }> = {};
      workspaces.forEach(workspace => {
        const repoId = workspace.repository_id || "unknown";
        if (!grouped[repoId]) {
          grouped[repoId] = {
            repo_id: repoId,
            repo_name: workspace.repo_name || "Unknown",
            sort_order: workspace.repo_sort_order ?? 999,
            workspaces: [],
          };
        }
        grouped[repoId].workspaces.push({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
      });

      // Backfill repos that have no matching workspaces (e.g. all archived)
      const allRepos = getAllRepositorySummaries(db);
      for (const repo of allRepos) {
        if (!grouped[repo.id]) {
          grouped[repo.id] = {
            repo_id: repo.id,
            repo_name: repo.name,
            sort_order: repo.sort_order ?? 999,
            workspaces: [],
          };
        }
      }

      return Object.values(grouped).sort((a, b) => a.sort_order - b.sort_order);
    })
    .with("stats", () => getStats(db))
    .with("sessions", () => {
      const workspaceId = readStringParam(params, "workspaceId");
      if (!workspaceId) throw new Error("sessions requires workspaceId param");
      return getSessionsByWorkspaceId(db, workspaceId);
    })
    .with("session", () => {
      const sessionId = readStringParam(params, "sessionId");
      if (!sessionId) throw new Error("session requires sessionId param");
      return getSessionById(db, sessionId);
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

      return { messages: rows, has_older: hasOlder, has_newer: hasNewer };
    })
    .exhaustive();
}

// ---- Mutation Dispatch ----

function runMutation(action: string, params: QueryParams): unknown {
  const typedAction = toMutationName(action);

  return match(typedAction)
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
