// backend/src/services/agent/tool-relay.ts
// Manages pending tool requests being relayed from the agent-server to the frontend.
//
// Flow:
//   Agent emits tool.request event
//   → handleAgentEvent calls toolRelay.relay()
//   → Backend pushes q:event { event: "tool:request", data: {...} } to all frontend WS clients
//   → Frontend handles the request (browser automation, diff, terminal, plan, question)
//   → Frontend sends q:tool_response { requestId, result/error } back via WS
//   → Backend calls toolRelay.resolve/reject
//   → relay() promise resolves → agent-event-handler sends result back to agent-server
//
// Timeout handling: each tool request has a timeout (set by the agent-server).
// If the frontend doesn't respond within the timeout, the pending promise is rejected.

import type { ToolRequestEvent } from "@shared/agent-events";
import type { ToolRequestEventData, QServerFrame } from "@shared/types/query-protocol";
import { broadcast } from "../ws.service";

// ---- Types ----

interface PendingRelay {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  method: string;
}

// ---- Singleton State ----

const pending = new Map<string, PendingRelay>();

// ---- Public API ----

/**
 * Relay a tool request from the agent to the frontend via WebSocket.
 *
 * Returns a promise that resolves when the frontend sends back q:tool_response,
 * or rejects if the timeout expires.
 *
 * The caller (agent-event-handler) uses the resolved value to send the result
 * back to the agent-server via agentClient.sendTurnRespond().
 */
export function relay(event: ToolRequestEvent): Promise<unknown> {
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

    // Store the pending relay
    pending.set(requestId, { resolve, reject, timer, sessionId, method });

    // Push q:event to all connected frontend clients
    const eventData: ToolRequestEventData = {
      requestId,
      sessionId,
      method,
      params,
      timeoutMs,
    };

    const frame: QServerFrame = {
      type: "q:event",
      event: "tool:request",
      data: eventData,
    };

    broadcast(JSON.stringify(frame));
  });
}

/**
 * Resolve a pending tool relay with the frontend's response.
 * Called when the query engine receives a q:tool_response frame with a result.
 */
export function resolve(requestId: string, result: unknown): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(result);
  return true;
}

/**
 * Reject a pending tool relay with an error from the frontend.
 * Called when the query engine receives a q:tool_response frame with an error.
 */
export function reject(requestId: string, error: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.reject(new Error(error));
  return true;
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
