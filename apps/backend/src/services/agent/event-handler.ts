// backend/src/services/agent/event-handler.ts
// Receives canonical AgentEvent notifications from the agent-client and
// dispatches them to persistence (DB writes) and WS push (query invalidation).
//
// This is the single entry point for all agent → backend data flow.
// Each event is handled: persist first, then invalidate (ordering matters).

import { match } from "ts-pattern";
import type { AgentEvent } from "@shared/agent-events";
import type { QueryResource, QServerFrame, ProtocolEvent } from "@shared/types/query-protocol";
import { invalidate } from "../query-engine";
import { broadcast } from "../ws.service";
import {
  persistMessageCancelled,
  persistMessageCreated,
  persistPartDone,
  persistMessageDone,
  persistSessionStarted,
  persistSessionIdle,
  persistSessionContextUsage,
  persistSessionError,
  persistSessionCancelled,
  persistAgentSessionId,
  persistSessionTitle,
  type WriteResult,
} from "./persistence";
import { refreshPrSnapshotForSession } from "../pr-snapshot.service";

// ---- Types ----

export type AgentEventHandler = (event: AgentEvent) => void;

// ---- Resource groups for invalidation ----

const SESSION_RESOURCES: QueryResource[] = ["workspaces", "sessions", "session", "stats"];
const MESSAGE_RESOURCES: QueryResource[] = ["messages", "session"];

// ---- Helpers ----

/** Persist an event and invalidate subscriptions if the write succeeded. */
function persistAndInvalidate(
  result: WriteResult<unknown>,
  resources: QueryResource[],
  sessionId: string
): void {
  if (result.ok) {
    invalidate(resources, { sessionIds: [sessionId] });
  }
}

/** Persist without invalidation. Used for part events where the frontend
 *  receives data via q:event (real-time) — the q:delta system would just
 *  run a wasted DB query since message seq doesn't change on part writes. */
function persistOnly(result: WriteResult<unknown>): void {
  if (!result.ok) {
    console.warn(`[AgentEvent] Persistence failed:`, result.error);
  }
}

/** Push a lifecycle event to all frontend connections as a q:event frame.
 *  The frontend filters by sessionId to route events to the correct session view. */
function pushEvent(event: ProtocolEvent, data: Omit<AgentEvent, "type">): void {
  const frame: QServerFrame = { type: "q:event", event, data };
  broadcast(JSON.stringify(frame));
}

// ---- Factory ----

/** Create the agent event handler: persistence + WS invalidation per event. */
export function createAgentEventHandler(): AgentEventHandler {
  return function handleAgentEvent(event: AgentEvent): void {
    match(event)
      // ── Session lifecycle ─────────────────────────────────────────────
      .with({ type: "session.started" }, (e) => {
        console.log(`[AgentEvent] session.started: session=${e.sessionId} agent=${e.agentHarness}`);
        persistAndInvalidate(persistSessionStarted(e), SESSION_RESOURCES, e.sessionId);
      })
      .with({ type: "session.idle" }, (e) => {
        console.log(`[AgentEvent] session.idle: session=${e.sessionId}`);
        persistAndInvalidate(persistSessionIdle(e), SESSION_RESOURCES, e.sessionId);
        // Turn ended — the agent may have created or updated a PR.
        refreshPrSnapshotForSession(e.sessionId);
      })
      .with({ type: "session.contextUsage" }, (e) => {
        persistAndInvalidate(persistSessionContextUsage(e), SESSION_RESOURCES, e.sessionId);
      })
      .with({ type: "session.error" }, (e) => {
        console.log(`[AgentEvent] session.error: session=${e.sessionId} error=${e.error}`);
        persistAndInvalidate(persistSessionError(e), SESSION_RESOURCES, e.sessionId);
        // The agent may have pushed a PR before the turn failed.
        refreshPrSnapshotForSession(e.sessionId);
      })
      .with({ type: "session.cancelled" }, (e) => {
        console.log(`[AgentEvent] session.cancelled: session=${e.sessionId}`);
        persistAndInvalidate(persistSessionCancelled(e), SESSION_RESOURCES, e.sessionId);
        // The agent may have pushed a PR before the turn was stopped.
        refreshPrSnapshotForSession(e.sessionId);
      })

      .with({ type: "message.cancelled" }, (e) => {
        console.log(`[AgentEvent] message.cancelled: session=${e.sessionId}`);
        persistAndInvalidate(
          persistMessageCancelled(e),
          ["messages", "sessions", "session", "stats"],
          e.sessionId
        );
      })

      // ── Turn, message & part lifecycle ────────────────────────────────
      .with({ type: "turn.started" }, (e) => {
        console.log(
          `[AgentEvent] turn.started: session=${e.sessionId} turnId=${e.turnId ?? "none"}`
        );
      })
      .with({ type: "message.created" }, (e) => {
        console.log(
          `[AgentEvent] message.created: session=${e.sessionId} messageId=${e.messageId}`
        );
        persistAndInvalidate(persistMessageCreated(e), MESSAGE_RESOURCES, e.sessionId);
        // Also push as q:event so frontend creates the message shell
        // BEFORE part events arrive (avoids race condition).
        const { type: _, ...data } = e;
        pushEvent("message:created", data);
      })
      .with({ type: "part.created" }, (e) => {
        console.log(
          `[AgentEvent] part.created: session=${e.sessionId} partId=${e.partId} type=${e.part.type}`
        );
        // Persist on first creation so in-flight parts survive session switches.
        // Uses INSERT OR REPLACE — safe for repeated part.created (state transitions).
        persistOnly(persistPartDone(e));
        const { type: _, ...data } = e;
        pushEvent("part:created", data);
      })
      .with({ type: "part.delta" }, (e) => {
        // High-frequency streaming event — no log, no persistence, just forward
        const { type: _, ...data } = e;
        pushEvent("part:delta", data);
      })
      .with({ type: "part.done" }, (e) => {
        console.log(
          `[AgentEvent] part.done: session=${e.sessionId} partId=${e.partId} type=${e.part.type}`
        );
        // Persist to DB (for page refresh). No invalidation needed —
        // the frontend receives part data via q:event, not q:delta.
        persistOnly(persistPartDone(e));
        const { type: _, ...data } = e;
        pushEvent("part:done", data);
      })
      .with({ type: "message.done" }, (e) => {
        console.log(
          `[AgentEvent] message.done: session=${e.sessionId} messageId=${e.messageId} stopReason=${e.stopReason ?? "none"}`
        );
        persistOnly(persistMessageDone(e));
        // Push as q:event so frontend can set stop_reason on the message
        const { type: _, ...data } = e;
        pushEvent("message:done", data);
      })
      .with({ type: "turn.completed" }, (e) => {
        console.log(
          `[AgentEvent] turn.completed: session=${e.sessionId} finishReason=${e.finishReason ?? "none"} cost=${e.cost ?? 0}`
        );
        // No message invalidation — all part data already streamed via q:event.
        // Session status change (session.idle) handles the UI update.
      })

      // ── Metadata ──────────────────────────────────────────────────────
      .with({ type: "agent.session_id" }, (e) => {
        console.log(
          `[AgentEvent] agent.session_id: session=${e.sessionId} agentSessionId=${e.agentSessionId}`
        );
        persistAndInvalidate(persistAgentSessionId(e), SESSION_RESOURCES, e.sessionId);
      })
      .with({ type: "session.title" }, (e) => {
        console.log(`[AgentEvent] session.title: session=${e.sessionId} title="${e.title}"`);
        persistAndInvalidate(persistSessionTitle(e), SESSION_RESOURCES, e.sessionId);
      })

      .exhaustive();
  };
}
