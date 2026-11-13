// backend/src/services/query-engine.ts
// Carries q:* frames between a connection and the operations it asks for.
//
// The engine knows no operation. A frame names one; the registry
// (`api/registry.ts`) validates the input and runs its handler. What lives here
// is what is true of every operation: how a frame is answered, who is asking,
// and keeping a live read fresh for the connections subscribed to it.
//
//   q:request   → a read            → q:response | q:error
//   q:mutate    → a write           → q:mutate_result
//   q:subscribe → a live read       → q:snapshot, then q:snapshot / q:delta
//               → a stream          → q:event (see services/streams.ts)
//
// Works the same for the local window, a device on the local network and a
// device behind the relay: all three are connections in ws.service.

import * as Sentry from "@sentry/node";
import { match } from "ts-pattern";
import { subscriptionKey } from "@deus/runtime-client";
import { streams, type LiveName } from "@shared/api";
import type { QServerFrame } from "@shared/types/query-protocol";
import type { Caller, Registry } from "../api/registry";
import { getDatabase } from "../lib/database";
import { AppError } from "../lib/errors";
import { toWorkspace } from "../lib/workspace-grouping";
import { getWorkspacesBySessionIds, resetStatsCache } from "../db";
import { rejectToolRelay, resolveToolRelay } from "./agent";
import * as streamHub from "./streams";
import { getConnection } from "./ws.service";

type Params = Record<string, unknown>;

// ---- Operations ----

let operations: Registry | null = null;

/**
 * Hand the engine every operation it may be asked for. Called once at startup
 * (`createApp`). Injected rather than imported: handlers call `invalidate()`
 * here, and `invalidate()` re-runs handlers, so a static import would be a cycle.
 */
export function serveOperations(registry: Registry): void {
  operations = registry;
}

function registry(): Registry {
  if (!operations) throw new Error("The query engine was asked before its operations were set");
  return operations;
}

const streamsByName = new Map(streams.map((stream) => [stream.name, stream]));

/** Who a connection speaks for: this computer's own window, or a paired device. */
function callerOf(connectionId: string): Caller {
  const connection = getConnection(connectionId);
  return { deviceId: connection?.deviceId ?? null, relayed: connection?.isVirtual === true };
}

/**
 * What to tell a client about a failure. A refusal (`AppError`) is the
 * operation saying no, with a reason the client shows. Anything else is a bug
 * in a handler: reported, and still answered with its own words, which on a
 * person's own computer are more use to them than "internal error".
 */
function describeFailure(error: unknown, fallback: string) {
  if (!(error instanceof AppError)) {
    Sentry.captureException(error);
    console.error("[QueryEngine] Unhandled error:", error);
  }
  return {
    message: error instanceof Error ? error.message : fallback,
    status: error instanceof AppError ? error.statusCode : undefined,
    details: error instanceof AppError ? error.details : undefined,
  };
}

// ---- Live subscriptions ----

interface Sub {
  id: string;
  resource: LiveName;
  params: Params;
}

/** Per-connection live reads, keyed by the subscription id the client chose. */
const subs = new Map<string, Map<string, Sub>>();

// ---- Frames ----

/** Handle one q:* frame from an admitted connection. */
export function handleFrame(connectionId: string, msg: Params): void {
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const id = typeof msg.id === "string" ? msg.id : "unknown";
  try {
    match(type)
      .with("q:request", () => void handleRequest(connectionId, parseCall(msg, "resource")))
      .with("q:mutate", () => void handleMutate(connectionId, parseCall(msg, "action")))
      .with("q:subscribe", () => handleSubscribe(connectionId, parseCall(msg, "resource"), msg))
      .with("q:unsubscribe", () => handleUnsubscribe(connectionId, requireString(msg.id, "id")))
      .with("q:tool_response", () => handleToolResponse(msg))
      .otherwise(() => {
        sendFrame(connectionId, {
          type: "q:error",
          id,
          code: "UNKNOWN_FRAME",
          message: `Unknown query frame type: ${type}`,
        });
      });
  } catch (error) {
    sendFrame(connectionId, {
      type: "q:error",
      id,
      code: "INVALID_FRAME",
      message: error instanceof Error ? error.message : "Invalid query frame",
    });
  }
}

/** A connection closed: forget what it was subscribed to. */
export function removeSubs(connectionId: string): void {
  subs.delete(connectionId);
  streamHub.dropConnection(connectionId);
}

interface Call {
  id: string;
  name: string;
  params: Params;
}

async function handleRequest(connectionId: string, { id, name, params }: Call): Promise<void> {
  try {
    const data = await registry().run(name, "read", params, { caller: callerOf(connectionId) });
    sendFrame(connectionId, { type: "q:response", id, data });
  } catch (error) {
    const { message } = describeFailure(error, "Query failed");
    sendFrame(connectionId, { type: "q:error", id, code: "QUERY_ERROR", message });
  }
}

async function handleMutate(connectionId: string, { id, name, params }: Call): Promise<void> {
  try {
    const data = await registry().run(name, "write", params, { caller: callerOf(connectionId) });
    sendFrame(connectionId, { type: "q:mutate_result", id, success: true, data });
  } catch (error) {
    const { message, status, details } = describeFailure(error, "Mutation failed");
    sendFrame(connectionId, {
      type: "q:mutate_result",
      id,
      success: false,
      error: message,
      status,
      details,
    });
  }
}

function handleSubscribe(connectionId: string, { id, name, params }: Call, msg: Params): void {
  try {
    const stream = streamsByName.get(name);
    if (stream) {
      const after = typeof msg.after === "number" ? msg.after : undefined;
      streamHub.subscribe(connectionId, id, stream, params, after);
      return;
    }

    const resource = name as LiveName;
    const data = registry().runLive(name, params, liveCtx(connectionId));

    let connSubs = subs.get(connectionId);
    if (!connSubs) subs.set(connectionId, (connSubs = new Map()));
    connSubs.set(id, { id, resource, params });
    sendFrame(connectionId, { type: "q:snapshot", id, data });
  } catch (error) {
    const { message } = describeFailure(error, "Subscribe failed");
    sendFrame(connectionId, { type: "q:error", id, code: "SUBSCRIBE_ERROR", message });
  }
}

function handleUnsubscribe(connectionId: string, id: string): void {
  if (streamHub.unsubscribe(connectionId, id)) return;
  const connSubs = subs.get(connectionId);
  const sub = connSubs?.get(id);
  if (!connSubs || !sub) return;
  connSubs.delete(id);
  if (connSubs.size === 0) subs.delete(connectionId);
}

function handleToolResponse(msg: Params): void {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
  if (!requestId) {
    console.error("[QueryEngine] q:tool_response missing requestId");
    return;
  }
  const settled =
    "error" in msg && msg.error !== undefined
      ? rejectToolRelay(
          requestId,
          typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)
        )
      : resolveToolRelay(requestId, msg.result);
  if (!settled) console.warn(`[QueryEngine] q:tool_response for unknown requestId=${requestId}`);
}

// ---- Invalidation ----

interface InvalidateContext {
  /** Only these sessions changed: narrows which subscriptions are re-sent, and how. */
  sessionIds?: string[];
}

/**
 * These live reads changed: send them again to the connections subscribed to
 * them, before returning.
 *
 * With `ctx.sessionIds`, `workspaces` is sent as a delta of just the workspaces
 * those sessions belong to.
 */
export function invalidate(resources: LiveName[], ctx?: InvalidateContext): void {
  // Shared only within this synchronous pass and one caller's view: no cached
  // read outlives a write or serves another device's view.
  const reads = new Map<string, unknown>();
  if (resources.includes("stats")) resetStatsCache();

  for (const [connectionId, connSubs] of subs) {
    if (!getConnection(connectionId)) {
      removeSubs(connectionId);
      continue;
    }
    for (const [subId, sub] of connSubs) {
      if (!resources.includes(sub.resource)) continue;
      const sessionId = typeof sub.params.sessionId === "string" ? sub.params.sessionId : undefined;
      const concerned =
        !ctx?.sessionIds?.length || (!!sessionId && ctx.sessionIds.includes(sessionId));

      if (sub.resource === "session" && !concerned) continue;
      if (
        sub.resource === "workspaces" &&
        ctx?.sessionIds?.length &&
        pushWorkspaceDelta(connectionId, subId, sub, ctx.sessionIds, reads)
      ) {
        continue;
      }
      pushSnapshot(connectionId, subId, sub, reads);
    }
  }
}

const liveCtx = (connectionId: string) => ({ caller: callerOf(connectionId) });

function pushSnapshot(connectionId: string, subId: string, sub: Sub, reads: Map<string, unknown>) {
  try {
    const data = sharedRead(reads, connectionId, [sub.resource, sub.params], () =>
      registry().runLive(sub.resource, sub.params, liveCtx(connectionId))
    );
    sendFrame(connectionId, { type: "q:snapshot", id: subId, data });
  } catch (error) {
    console.error(`[QueryEngine] Snapshot push failed for ${sub.resource}:`, error);
  }
}

/** The changed workspaces only. False when a snapshot is needed instead. */
function pushWorkspaceDelta(
  connectionId: string,
  subId: string,
  sub: Sub,
  sessionIds: string[],
  reads: Map<string, unknown>
): boolean {
  try {
    const filter =
      typeof sub.params.state === "string" ? sub.params.state : "ready,initializing,error";
    const shown = new Set(filter.split(",").map((state) => state.trim()));
    const changed = sharedRead(reads, connectionId, ["workspace-delta", sessionIds], () =>
      getWorkspacesBySessionIds(getDatabase(), sessionIds)
    );
    // A deleted or no-longer-current session cannot identify its old workspace.
    // A snapshot can remove that row reliably; an upsert-only delta cannot.
    if (changed.length < new Set(sessionIds).size) return false;
    const removed = changed.filter((ws) => !shown.has(ws.state)).map((ws) => ws.id);
    sendFrame(connectionId, {
      type: "q:delta",
      id: subId,
      upserted: changed.filter((ws) => shown.has(ws.state)).map(toWorkspace),
      ...(removed.length ? { removed } : {}),
    });
    return true;
  } catch (error) {
    console.error("[QueryEngine] Workspace delta failed, falling back to snapshot:", error);
    return false;
  }
}

/** One read per caller's view within an invalidation, however many subscriptions ask. */
function sharedRead<T>(
  reads: Map<string, unknown>,
  connectionId: string,
  query: unknown,
  read: () => T
): T {
  const { deviceId, relayed } = callerOf(connectionId);
  const key = subscriptionKey([deviceId, relayed, query]);
  if (reads.has(key)) return reads.get(key) as T;
  const value = read();
  reads.set(key, value);
  return value;
}

// ---- Helpers ----

function sendFrame(connectionId: string, frame: QServerFrame): void {
  try {
    getConnection(connectionId)?.ws.send(JSON.stringify(frame));
  } catch {
    // The connection is closing.
  }
}

function parseCall(msg: Params, nameField: "resource" | "action"): Call {
  const params = msg.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Frame params must be an object");
  }
  return {
    id: requireString(msg.id, "id"),
    name: requireString(msg[nameField], nameField),
    params: params as Params,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Frame requires string ${field}`);
  return value;
}
