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
import { z } from "zod";
import { subscriptionKey } from "@deus/runtime-client";
import { streams, type LiveName } from "@shared/api";
import type { QServerFrame } from "@shared/types/query-protocol";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
import { LOCAL_CALLER, type Caller, type Registry } from "../api/registry";
import { getDatabase } from "../lib/database";
import { AppError } from "../lib/errors";
import { toWorkspace } from "../lib/workspace-grouping";
import { getWorkspacesBySessionIds } from "../db";
import { answerToolRequest } from "./agent";
import { ASSISTANT_FAILURE, ASSISTANT_TOOLS_ONLY } from "./assistants/sentences";
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

/**
 * Run an operation as this computer itself, validated like a frame. For code
 * that acts on someone's behalf after deciding itself what they may do (the
 * operator tools an assistant calls), not for answering a frame.
 */
export function runAsThisComputer<O extends AnyOp>(op: O, input: InputOf<O>): Promise<OutputOf<O>> {
  return registry().run(op.name, op.kind, input, { caller: LOCAL_CALLER }) as Promise<OutputOf<O>>;
}

const streamsByName = new Map(streams.map((stream) => [stream.name, stream]));

/** Who a connection speaks for: this computer's own window, a paired device, or an assistant. */
function callerOf(connectionId: string): Caller {
  const connection = getConnection(connectionId);
  return {
    deviceId: connection?.deviceId ?? null,
    relayed: connection?.isVirtual === true,
    assistant: connection?.assistant ?? null,
    ...(connection?.endsAt !== undefined ? { endsAt: connection.endsAt } : {}),
  };
}

/**
 * What to tell a client about a failure. A refusal (`AppError`) is the
 * operation saying no, with a reason the client shows. Anything else is a bug
 * in a handler: reported, and still answered with its own words, which on a
 * person's own computer are more use to them than "internal error". An
 * assistant is not the person: it gets one sentence, never internal text.
 */
function describeFailure(error: unknown, fallback: string, caller?: Caller) {
  const refusal = error instanceof AppError;
  if (!refusal) {
    Sentry.captureException(error);
    console.error("[QueryEngine] Unhandled error:", error);
  }
  return {
    message:
      !refusal && caller?.assistant
        ? ASSISTANT_FAILURE
        : error instanceof Error
          ? error.message
          : fallback,
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
  // An assistant asks and is answered (q:request, q:mutate, checked by the
  // registry). It follows no live read or stream, and answers no agent's
  // question directly: the operator tools do that on its behalf.
  if ((type === "q:subscribe" || type === "q:tool_response") && callerOf(connectionId).assistant) {
    sendFrame(connectionId, {
      type: "q:error",
      id,
      code: "FORBIDDEN",
      message: ASSISTANT_TOOLS_ONLY,
    });
    return;
  }
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
  const caller = callerOf(connectionId);
  try {
    const data = await registry().run(name, "read", params, { caller });
    sendFrame(connectionId, { type: "q:response", id, data });
  } catch (error) {
    const { message } = describeFailure(error, "Query failed", caller);
    sendFrame(connectionId, { type: "q:error", id, code: "QUERY_ERROR", message });
  }
}

async function handleMutate(connectionId: string, { id, name, params }: Call): Promise<void> {
  const caller = callerOf(connectionId);
  try {
    const data = await registry().run(name, "write", params, { caller });
    sendFrame(connectionId, { type: "q:mutate_result", id, success: true, data });
  } catch (error) {
    const { message, status, details } = describeFailure(error, "Mutation failed", caller);
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
  const settled = answerToolRequest(
    requestId,
    "error" in msg && msg.error !== undefined
      ? { error: typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error) }
      : { result: msg.result }
  );
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
  for (const listener of [...invalidationListeners]) listener(resources, ctx);

  for (const [connectionId, connSubs] of subs) {
    if (!getConnection(connectionId)) {
      removeSubs(connectionId);
      continue;
    }
    for (const [subId, sub] of connSubs) {
      if (!resources.includes(sub.resource)) continue;
      const { sessionId } = sub.params;
      if (
        typeof sessionId === "string" &&
        ctx?.sessionIds?.length &&
        !ctx.sessionIds.includes(sessionId)
      ) {
        const input = registry().find(sub.resource)?.input;
        if (input instanceof z.ZodObject && "sessionId" in input.shape) continue;
      }
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

const invalidationListeners = new Set<
  (resources: readonly LiveName[], ctx?: InvalidateContext) => void
>();

/**
 * Hear of every invalidation, whoever subscribed to what (an operator tool
 * waiting for a chat to change). Returns the function that stops it.
 */
export function onInvalidate(
  listener: (resources: readonly LiveName[], ctx?: InvalidateContext) => void
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
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
    // Several chats can share a row. A deleted or hidden chat needs a fresh snapshot.
    const missing = new Set(sessionIds);
    for (const workspace of changed) {
      for (const chat of workspace.chats) missing.delete(chat.id);
    }
    if (missing.size) return false;
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
