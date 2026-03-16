// backend/src/services/agent-event-handler.ts
// Receives canonical AgentEvent notifications from the agent-client and
// dispatches them to persistence (DB writes) and WS push (query invalidation).
//
// This is the single entry point for all agent → backend data flow.
// Each event is handled: persist first, then invalidate (ordering matters).
//
// Created via createAgentEventHandler() — a factory that injects the
// respondToAgent dependency, breaking the circular import with agent-service.

import { match } from "ts-pattern";
import type { AgentEvent } from "../../../shared/agent-events";
import type { QueryResource } from "../../../shared/types/query-protocol";
import { invalidate } from "./query-engine";
import { relay } from "./tool-relay";
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

// ---- Types ----

type RespondToAgentFn = (params: {
  sessionId: string;
  requestId: string;
  result: unknown;
}) => Promise<void>;

export type AgentEventHandler = (event: AgentEvent) => void;

// ---- Factory ----

/**
 * Create an agent event handler with injected dependencies.
 *
 * The respondToAgent function is injected to break the circular dependency
 * between this module and agent-service.ts. The composition root (agent-service)
 * provides the concrete implementation: client.sendTurnRespond().
 */
export function createAgentEventHandler(deps: {
  respondToAgent: RespondToAgentFn;
}): AgentEventHandler {
  const { respondToAgent } = deps;

  return function handleAgentEvent(event: AgentEvent): void {
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
      })
      .with({ type: "request.resolved" }, (e) => {
        console.log(`[AgentEvent] request.resolved: session=${e.sessionId} requestId=${e.requestId}`);
      })

      // ── Tool relay ────────────────────────────────────────────────────
      .with({ type: "tool.request" }, (e) => {
        console.log(`[AgentEvent] tool.request: session=${e.sessionId} method=${e.method} requestId=${e.requestId}`);
        void relayToolRequest(e, respondToAgent);
      })

      // ── Metadata ──────────────────────────────────────────────────────
      .with({ type: "agent.session_id" }, (e) => {
        console.log(`[AgentEvent] agent.session_id: session=${e.sessionId} agentSessionId=${e.agentSessionId}`);
        persistAgentSessionId(e);
      })

      .exhaustive();
  };
}

// ---- Tool relay internal ----

async function relayToolRequest(
  event: AgentEvent & { type: "tool.request" },
  respondToAgent: RespondToAgentFn,
): Promise<void> {
  const { sessionId, requestId, method } = event;

  try {
    const result = await relay(event);
    await respondToAgent({ sessionId, requestId, result });
    console.log(`[AgentEvent] tool.request resolved: requestId=${requestId} method=${method}`);
  } catch (err) {
    console.error(`[AgentEvent] tool.request failed: requestId=${requestId} method=${method}`, err);
    try {
      await respondToAgent({
        sessionId,
        requestId,
        result: { error: err instanceof Error ? err.message : "Tool relay failed" },
      });
    } catch (respondErr) {
      console.error(`[AgentEvent] Failed to send error response to agent: requestId=${requestId}`, respondErr);
    }
  }
}
