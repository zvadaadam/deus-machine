// backend/src/services/agent-event-handler.ts
// Receives canonical AgentEvent notifications from the agent-client and
// dispatches them to persistence and WS push.
//
// STUB: PR 2 establishes the wiring. PR 3 will implement the full
// persistence flow (save messages, update session status, invalidate queries).

import { match, P } from "ts-pattern";
import type { AgentEvent } from "../../../shared/agent-events";

/**
 * Process a single canonical agent event.
 *
 * Called by the AgentClient for every event notification received from the
 * agent-server. This is the single entry point for all agent → backend data flow.
 *
 * TODO (PR 3): Wire each event to:
 * - agent-persistence.ts — DB writes (messages, session status)
 * - query-engine.ts — invalidate WS subscriptions for affected resources
 */
export function handleAgentEvent(event: AgentEvent): void {
  match(event)
    // Session lifecycle
    .with({ type: "session.started" }, (e) => {
      console.log(`[AgentEvent] session.started: session=${e.sessionId} agent=${e.agentType}`);
      // TODO: Update session status to "working"
    })
    .with({ type: "session.idle" }, (e) => {
      console.log(`[AgentEvent] session.idle: session=${e.sessionId}`);
      // TODO: Update session status to "idle", invalidate session + workspace queries
    })
    .with({ type: "session.error" }, (e) => {
      console.log(`[AgentEvent] session.error: session=${e.sessionId} error=${e.error}`);
      // TODO: Update session status to "error", persist error details
    })
    .with({ type: "session.cancelled" }, (e) => {
      console.log(`[AgentEvent] session.cancelled: session=${e.sessionId}`);
      // TODO: Update session status to "idle" (cancelled = back to idle)
    })

    // Messages
    .with({ type: "message.assistant" }, (e) => {
      console.log(`[AgentEvent] message.assistant: session=${e.sessionId} msgId=${e.message.id}`);
      // TODO: Save assistant message via agent-persistence, invalidate messages query
    })
    .with({ type: "message.tool_result" }, (e) => {
      console.log(`[AgentEvent] message.tool_result: session=${e.sessionId} msgId=${e.message.id}`);
      // TODO: Save tool result message via agent-persistence, invalidate messages query
    })
    .with({ type: "message.result" }, (e) => {
      console.log(`[AgentEvent] message.result: session=${e.sessionId} subtype=${e.subtype}`);
      // TODO: Handle result/success and result/error_during_execution subtypes
    })
    .with({ type: "message.cancelled" }, (e) => {
      console.log(`[AgentEvent] message.cancelled: session=${e.sessionId}`);
      // TODO: Persist cancellation marker message
    })

    // Interaction requests
    .with({ type: "request.opened" }, (e) => {
      console.log(`[AgentEvent] request.opened: session=${e.sessionId} requestId=${e.requestId} type=${e.requestType}`);
      // TODO: Forward to frontend via WS push (needs_response / needs_plan_response)
    })
    .with({ type: "request.resolved" }, (e) => {
      console.log(`[AgentEvent] request.resolved: session=${e.sessionId} requestId=${e.requestId}`);
      // TODO: Update session status back to "working"
    })

    // Tool relay
    .with({ type: "tool.request" }, (e) => {
      console.log(`[AgentEvent] tool.request: session=${e.sessionId} method=${e.method} requestId=${e.requestId}`);
      // TODO: Forward tool request to frontend (browser, terminal, diff, etc.)
    })

    // Metadata
    .with({ type: "agent.session_id" }, (e) => {
      console.log(`[AgentEvent] agent.session_id: session=${e.sessionId} agentSessionId=${e.agentSessionId}`);
      // TODO: Store agent session ID mapping for resume support
    })

    .exhaustive();
}
