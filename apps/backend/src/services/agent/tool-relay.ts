// backend/src/services/agent/tool-relay.ts
// Manages pending tool requests being relayed from the agent-server to the frontend.
//
// Flow:
//   Agent emits tool.request event
//   → handleAgentEvent calls toolRelay.relay()
//   → Backend publishes it on `toolRequests` to the clients following that chat
//   → Frontend handles the request (browser automation, diff, terminal, plan, question)
//   → Frontend sends q:tool_response { requestId, result/error } back via WS
//   → Backend calls toolRelay.answer
//   → relay() promise resolves → agent-event-handler sends result back to agent-server
//
// Timeout handling: each tool request has a timeout (set by the agent-server).
// If the frontend doesn't respond within the timeout, the pending promise is rejected.
//
// A request is answered once, by whoever answers first (a window's card, a
// phone, an assistant), through `answer`; when it showed a person a prompt (a
// question, a plan), the others are told to withdraw theirs. One that starts
// following a chat later is sent the prompts it still waits on (`pendingFor`,
// `isPrompt`).

import type { ToolRequestEventData } from "@shared/types/query-protocol";
import { toolRequests } from "@shared/api/sessions";
import { publish } from "../streams";

// ---- Types ----

interface PendingRelay {
  turnId?: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The request as clients are sent it. */
  request: ToolRequestEventData;
}

// ---- Singleton State ----

const pending = new Map<string, PendingRelay>();

// ---- Public API ----

/**
 * Relay a tool request from the agent to the frontend via WebSocket.
 *
 * Returns a promise that resolves when the frontend sends back q:tool_response,
 * or rejects if the timeout expires.
 */
export function relay(
  event: ToolRequestEventData & { type?: string; turnId?: string }
): Promise<unknown> {
  const { requestId, sessionId, method, params, timeoutMs } = event;

  // If there's already a pending request with this ID, reject the old one
  // (shouldn't happen in practice, but prevents leaked promises)
  const existing = pending.get(requestId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error(`Superseded by new relay for requestId=${requestId}`));
    pending.delete(requestId);
  }

  return new Promise<unknown>((resolve, reject) => {
    // Set timeout — reject if frontend doesn't respond in time
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(
        new Error(
          `Tool relay timed out after ${timeoutMs}ms (requestId=${requestId}, method=${method})`
        )
      );
    }, timeoutMs);

    const request = { requestId, sessionId, method, params, timeoutMs };
    pending.set(requestId, { resolve, reject, timer, request, turnId: event.turnId });
    publish(toolRequests, { sessionId }, { type: "request", request });
  });
}

/**
 * What a chat's agent still waits on (every chat's without one), oldest first:
 * for a client that arrives after it asked.
 */
export function pendingFor(sessionId?: string): ToolRequestEventData[] {
  const waiting: ToolRequestEventData[] = [];
  for (const { request } of pending.values()) {
    if (sessionId === undefined || request.sessionId === sessionId) waiting.push(request);
  }
  return waiting;
}

/** A client's reply to a request: what it asked for, or why it could not. */
export type ToolReply = { result: unknown } | { error: string };

/**
 * Answer a pending request, from whichever client answers first (a window's
 * card through `q:tool_response`, an assistant through the operator tools).
 * The other clients drop their prompt for it. Returns whether it was pending.
 */
export function answer(requestId: string, reply: ToolReply): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(requestId);
  if ("error" in reply) entry.reject(new Error(reply.error));
  else entry.resolve(reply.result);
  if (isPrompt(entry.request.method)) {
    const { sessionId } = entry.request;
    publish(toolRequests, { sessionId }, { type: "cancel", sessionId, requestId });
  }
  return true;
}

/**
 * Whether `method` is a request a person answers on a card (a question, a
 * plan). The rest (a diff, a terminal's output) a client answers by itself:
 * it shows nothing to withdraw, and is never sent again to a late follower.
 */
export function isPrompt(method: string): boolean {
  return method === "askUserQuestion" || method === "exitPlanMode";
}

/**
 * Reject one pending relay and tell the renderer to drop its overlay: what it
 * asked was settled elsewhere. Returns whether it was pending.
 */
export function cancelRelay(requestId: string, reason: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.reject(new Error(`Tool relay cancelled: ${reason} (requestId=${requestId})`));
  const { sessionId } = entry.request;
  publish(toolRequests, { sessionId }, { type: "cancel", sessionId, requestId });
  return true;
}

/** Withdraw this turn's requests, or all of the chat's when no turn is specified. */
export function cancelSessionRelays(sessionId: string, reason: string, turnId?: string): string[] {
  const cancelled: string[] = [];
  for (const [requestId, entry] of [...pending]) {
    if (entry.request.sessionId !== sessionId || (turnId !== undefined && entry.turnId !== turnId))
      continue;
    if (cancelRelay(requestId, reason)) cancelled.push(requestId);
  }
  return cancelled;
}

/**
 * Get the number of pending relays (for diagnostics / tests).
 */
export function getPendingCount(): number {
  return pending.size;
}

/**
 * Clear all pending relays (for shutdown / tests).
 * Rejects all pending promises with a shutdown error.
 */
export function clearAll(): void {
  for (const [requestId, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`Tool relay cleared (requestId=${requestId})`));
  }
  pending.clear();
}
