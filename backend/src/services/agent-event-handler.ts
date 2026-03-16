// backend/src/services/agent-event-handler.ts
// Receives canonical AgentEvent notifications from the agent-client and
// dispatches them to persistence (DB writes) and WS push (query invalidation).
//
// This is the single entry point for all agent -> backend data flow.
// Each event is handled: persist first, then invalidate (ordering matters).
//
// Tool relay: tool.request events are relayed to the frontend via WS.
// When the frontend responds, the result is sent back to the agent-server
// via the registered respondToAgent callback.

import { match } from "ts-pattern";
import type { AgentEvent } from "../../../shared/agent-events";
import type { QueryResource } from "../../../shared/types/query-protocol";
import { invalidate } from "./query-engine";
import { relay } from "./tool-relay";
import * as agentService from "./agent-service";
import {
  persistAssistantMessage,
  persistToolResultMessage,
  persistMessageResult,
  persistMessageCancelled,
  persistSessionStarted,
  persistSessionIdle,
  persistSessionError,
  persistSessionCancelled,
  persistAgentSessionId,
} from "./agent-persistence";

/**
 * Process a single canonical agent event.
 *
 * Called by the AgentClient for every event notification received from the
 * agent-server. Ordering guarantee: DB write completes before WS push
 * so subscribers always see fresh data.
 */
export function handleAgentEvent(event: AgentEvent): void {
  match(event)
    // ── Session lifecycle ─────────────────────────────────────────────
    .with({ type: "session.started" }, (e) => {
      console.log(`[AgentEvent] session.started: session=${e.sessionId} agent=${e.agentType}`);
      const result = persistSessionStarted(e);
      if (result.ok) {
        invalidate(
          ["workspaces", "sessions", "session", "stats"],
          { sessionIds: [e.sessionId] }
        );
      }
    })
    .with({ type: "session.idle" }, (e) => {
      console.log(`[AgentEvent] session.idle: session=${e.sessionId}`);
      const result = persistSessionIdle(e);
      if (result.ok) {
        invalidate(
          ["workspaces", "sessions", "session", "stats"],
          { sessionIds: [e.sessionId] }
        );
      }
    })
    .with({ type: "session.error" }, (e) => {
      console.log(`[AgentEvent] session.error: session=${e.sessionId} error=${e.error}`);
      const result = persistSessionError(e);
      if (result.ok) {
        invalidate(
          ["workspaces", "sessions", "session", "stats"],
          { sessionIds: [e.sessionId] }
        );
      }
    })
    .with({ type: "session.cancelled" }, (e) => {
      console.log(`[AgentEvent] session.cancelled: session=${e.sessionId}`);
      const result = persistSessionCancelled(e);
      if (result.ok) {
        invalidate(
          ["workspaces", "sessions", "session", "stats"],
          { sessionIds: [e.sessionId] }
        );
      }
    })

    // ── Messages ──────────────────────────────────────────────────────
    .with({ type: "message.assistant" }, (e) => {
      console.log(`[AgentEvent] message.assistant: session=${e.sessionId} msgId=${e.message.id}`);
      const result = persistAssistantMessage(e);
      if (result.ok) {
        invalidate(
          ["messages", "session"] satisfies QueryResource[],
          { sessionIds: [e.sessionId] }
        );
      }
    })
    .with({ type: "message.tool_result" }, (e) => {
      console.log(`[AgentEvent] message.tool_result: session=${e.sessionId} msgId=${e.message.id}`);
      const result = persistToolResultMessage(e);
      if (result.ok) {
        invalidate(
          ["messages", "session"] satisfies QueryResource[],
          { sessionIds: [e.sessionId] }
        );
      }
    })
    .with({ type: "message.result" }, (e) => {
      console.log(`[AgentEvent] message.result: session=${e.sessionId} subtype=${e.subtype}`);
      // No DB write — informational only. Session status handled by session.idle/error.
      persistMessageResult(e);
    })
    .with({ type: "message.cancelled" }, (e) => {
      console.log(`[AgentEvent] message.cancelled: session=${e.sessionId}`);
      const result = persistMessageCancelled(e);
      if (result.ok) {
        invalidate(
          ["messages", "sessions", "session", "stats"],
          { sessionIds: [e.sessionId] }
        );
      }
    })

    // ── Interaction requests ──────────────────────────────────────────
    .with({ type: "request.opened" }, (e) => {
      console.log(`[AgentEvent] request.opened: session=${e.sessionId} requestId=${e.requestId} type=${e.requestType}`);
      // No DB write — relay to frontend via WS push (future: dedicated event channel)
    })
    .with({ type: "request.resolved" }, (e) => {
      console.log(`[AgentEvent] request.resolved: session=${e.sessionId} requestId=${e.requestId}`);
      // No DB write — informational
    })

    // ── Tool relay ────────────────────────────────────────────────────
    .with({ type: "tool.request" }, (e) => {
      console.log(`[AgentEvent] tool.request: session=${e.sessionId} method=${e.method} requestId=${e.requestId}`);
      // Fire-and-forget: relay to frontend, then send response back to agent-server.
      // Errors are logged but don't crash the event handler.
      void relayToolRequest(e);
    })

    // ── Metadata ──────────────────────────────────────────────────────
    .with({ type: "agent.session_id" }, (e) => {
      console.log(`[AgentEvent] agent.session_id: session=${e.sessionId} agentSessionId=${e.agentSessionId}`);
      persistAgentSessionId(e);
      // No invalidation needed — agent_session_id is not exposed in any query
    })

    .exhaustive();
}

// ---- Tool relay internal ----

/**
 * Relay a tool request to the frontend and send the result back to the agent-server.
 *
 * This is async (fire-and-forget from handleAgentEvent). The relay() promise
 * resolves when the frontend sends q:tool_response, then we forward the result
 * to the agent via turn/respond.
 */
async function relayToolRequest(event: AgentEvent & { type: "tool.request" }): Promise<void> {
  const { sessionId, requestId, method } = event;

  try {
    const result = await relay(event);

    // Send the frontend's result back to the agent-server
    await agentService.respondToAgent({ sessionId, requestId, result });
    console.log(`[AgentEvent] tool.request resolved: requestId=${requestId} method=${method}`);
  } catch (err) {
    console.error(`[AgentEvent] tool.request failed: requestId=${requestId} method=${method}`, err);
    // Send an error result back so the agent doesn't hang waiting
    try {
      await agentService.respondToAgent({
        sessionId,
        requestId,
        result: { error: err instanceof Error ? err.message : "Tool relay failed" },
      });
    } catch (respondErr) {
      console.error(`[AgentEvent] Failed to send error response to agent: requestId=${requestId}`, respondErr);
    }
  }
}
