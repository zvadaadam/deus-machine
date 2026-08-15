// backend/src/services/agent/event-handler.ts
// The single entry point for agent → backend data flow.
//
// It consumes the @zvada/agent-server lifecycle stream NATIVELY: one
// `match(envelope.event)` that persists (DB writes) and pushes (`agent:event`
// + query invalidation). There is no translation layer — the event that
// crosses the wire is the event that hits SQLite and the event the frontend
// folds (with deus's own fold, `lib/agentEventFold` — not the engine's
// `reduceConversation`; see that file for why).
//
// Ordering matters: persist first, then invalidate.

import { match } from "ts-pattern";
import { classifyError } from "@zvada/agent-server/protocol";
import type { ErrorEvent, TurnEndedEvent } from "@zvada/agent-server/protocol";
import { isUnknownLifecycleEvent, type AnyWireEventEnvelope } from "@shared/protocol-types";
import type { QueryResource, QServerFrame } from "@shared/types/query-protocol";
import { invalidate } from "../query-engine";
import { broadcast } from "../ws.service";
import {
  persistAgentSessionId,
  persistCompaction,
  persistMessageStarted,
  persistPart,
  persistSessionError,
  persistSessionTitle,
  persistSessionUsage,
  persistTurnEnded,
  type TurnOutcomeWrite,
  type WriteResult,
} from "./persistence";
import { refreshPrSnapshotForSession } from "../pr-snapshot.service";

// ---- Types ----

export interface AgentEventHandler {
  /** Feed one sequenced wire envelope (post-dedupe, in seq order). */
  handle(envelope: AnyWireEventEnvelope): void;
  /**
   * Mirror a turn admission before its quick-ack round-trip, so the handler
   * knows which turn is live when the first envelopes arrive in the same tick
   * as the ack. Returns false — touching nothing — when the session already
   * has a live turn: a concurrent send is about to be rejected with
   * `turnActive`, and clobbering the running turn's state would lose its error
   * dedupe. Callers re-register with `force` if the server accepts anyway
   * (stale local state, e.g. after a backend restart).
   */
  beginTurn(sessionId: string, turnId: string, opts?: { force?: boolean }): boolean;
  /** Roll back a beginTurn whose start was rejected (only if still ours). */
  abortTurn(sessionId: string, turnId: string): void;
  /** Side-channel title notification (deus/*, not a lifecycle event). */
  handleTitle(sessionId: string, title: string): void;
}

interface SessionState {
  /** The live turn — cleared at its turn.ended. */
  turnId?: string;
  /** One terminal error per turn: turn.ended(error) must not double-report. */
  errorReported: boolean;
}

// ---- Resource groups for invalidation ----

const SESSION_RESOURCES: QueryResource[] = ["workspaces", "sessions", "session", "stats"];
const MESSAGE_RESOURCES: QueryResource[] = ["messages", "session"];
const TURN_END_RESOURCES: QueryResource[] = [
  "workspaces",
  "sessions",
  "session",
  "stats",
  "messages",
];

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

/** Persist without invalidation — the frontend has the data via agent:event
 *  already, and a q:delta would just run a wasted query. */
function persistOnly(result: WriteResult<unknown>): void {
  if (!result.ok) {
    console.warn(`[AgentEvent] Persistence failed:`, result.error);
  }
}

/**
 * Push one wire envelope to every frontend connection verbatim. The frontend
 * routes by `sessionId` and orders/dedupes by `seq` — both free because the
 * envelope is not reshaped on its way through the backend.
 */
function pushEnvelope(envelope: AnyWireEventEnvelope): void {
  const frame: QServerFrame = { type: "q:event", event: "agent:event", data: envelope };
  broadcast(JSON.stringify(frame));
}

/** The terminal state a stopReason leaves the session in. Exported so the
 *  verification CLI decides it the same way instead of re-deriving it. */
export function turnOutcome(event: TurnEndedEvent, alreadyReported: boolean): TurnOutcomeWrite {
  if (event.stopReason === "cancelled") {
    return { status: "idle", cancelled: true };
  }
  if (event.stopReason === "error") {
    // A standalone `error` event already wrote the status + message; the
    // terminal event must not overwrite it with a vaguer one.
    if (alreadyReported) return { status: "error", cancelled: false };
    const message = event.error?.message ?? "Agent turn failed";
    return {
      status: "error",
      cancelled: false,
      error: { message, category: event.error?.category ?? classifyError(new Error(message)) },
    };
  }
  // end_turn, max_tokens, refusal, max_turn_requests and any adapter
  // extension: the turn is over and the session is idle. The outcome itself
  // survives in messages.turn_stop_reason for the UI to explain.
  return { status: "idle", cancelled: false };
}

// ---- Factory ----

/** Create the agent event handler: persistence + WS push per lifecycle event. */
export function createAgentEventHandler(): AgentEventHandler {
  const sessions = new Map<string, SessionState>();

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = { errorReported: false };
    sessions.set(sessionId, created);
    return created;
  };

  return {
    beginTurn(sessionId, turnId, opts = {}) {
      const existing = sessions.get(sessionId);
      if (existing?.turnId !== undefined && !opts.force) return false;
      sessions.set(sessionId, { turnId, errorReported: false });
      return true;
    },

    abortTurn(sessionId, turnId) {
      const state = sessions.get(sessionId);
      if (state?.turnId === turnId) state.turnId = undefined;
    },

    handleTitle(sessionId, title) {
      console.log(`[AgentEvent] deus/title: session=${sessionId} title="${title}"`);
      persistAndInvalidate(persistSessionTitle(sessionId, title), SESSION_RESOURCES, sessionId);
    },

    handle(envelope) {
      // The envelope always carries the session id; some event members (e.g.
      // `error`) leave it optional in the body.
      const sessionId = envelope.sessionId;
      const state = stateFor(sessionId);

      if (isUnknownLifecycleEvent(envelope.event)) {
        // Law 6: an event type this build does not know. Forward it verbatim —
        // dropping it would be a hole in the frontend's transcript and a
        // fabricated seq gap for anything counting envelopes. Nothing to
        // persist: deus knows no columns for a shape it cannot read.
        console.warn(
          `[AgentEvent] unknown event type: session=${sessionId} ${envelope.event.type}`
        );
        pushEnvelope(envelope);
        return;
      }

      match(envelope.event)
        // ── Session lifecycle ─────────────────────────────────────────────
        .with({ type: "session.created" }, (e) => {
          console.log(
            `[AgentEvent] session.created: session=${sessionId} native=${e.nativeSessionId} harness=${e.harness}${
              e.resumed === false ? " resumed=false" : ""
            }`
          );
          if (e.resumed === false) {
            // The harness was asked to continue a conversation and started a
            // fresh one instead: the context is gone. Silently swallowing this
            // is how "the agent forgot everything" becomes invisible — the
            // envelope carries the flag to the UI, which surfaces the warning.
            console.warn(
              `[AgentEvent] session ${sessionId} did NOT resume — the harness started a fresh session (context lost)`
            );
          }
          persistAndInvalidate(
            persistAgentSessionId(sessionId, e.nativeSessionId),
            SESSION_RESOURCES,
            sessionId
          );
          pushEnvelope(envelope);
        })
        .with({ type: "session.ended" }, (e) => {
          console.log(`[AgentEvent] session.ended: session=${sessionId} reason=${e.reason}`);
          // The session is over — drop its state. This is the event that
          // exists for exactly that; without it the map only grows.
          sessions.delete(sessionId);
        })
        .with({ type: "session.usage" }, (e) => {
          persistAndInvalidate(persistSessionUsage(e), SESSION_RESOURCES, sessionId);
        })
        .with({ type: "session.compaction" }, (e) => {
          console.log(
            `[AgentEvent] session.compaction: session=${sessionId} id=${e.compactionId} status=${e.status}`
          );
          persistAndInvalidate(persistCompaction(e), MESSAGE_RESOURCES, sessionId);
          pushEnvelope(envelope);
        })

        // ── Turn lifecycle ────────────────────────────────────────────────
        .with({ type: "turn.started" }, (e) => {
          console.log(`[AgentEvent] turn.started: session=${sessionId} turn=${e.turnId}`);
          // Nothing to persist: status='working' was written optimistically by
          // the send command. Keep the admission mirror truthful on the replay
          // path too (state rebuilt after a backend restart has no turnId).
          state.turnId = e.turnId;
          // A turn deus did NOT admit via beginTurn (replay, engine-initiated)
          // would otherwise inherit the previous turn's dedupe flag, and its
          // terminal error message would be dropped as "already reported".
          state.errorReported = false;
        })
        .with({ type: "turn.ended" }, (e) => {
          console.log(
            `[AgentEvent] turn.ended: session=${sessionId} turn=${e.turnId} stopReason=${e.stopReason} cost=${e.cost ?? 0}`
          );
          const outcome = turnOutcome(e, state.errorReported);
          if (state.turnId === e.turnId) state.turnId = undefined;
          if (outcome.status === "error") state.errorReported = true;
          persistAndInvalidate(persistTurnEnded(e, outcome), TURN_END_RESOURCES, sessionId);
          pushEnvelope(envelope);
          // The agent may have created, updated or pushed a PR during the turn.
          refreshPrSnapshotForSession(sessionId);
        })

        // ── Message + part lifecycle ──────────────────────────────────────
        .with({ type: "message.started" }, (e) => {
          console.log(
            `[AgentEvent] message.started: session=${sessionId} message=${e.messageId} role=${e.role} turn=${e.turnId}`
          );
          persistAndInvalidate(persistMessageStarted(e), MESSAGE_RESOURCES, sessionId);
          pushEnvelope(envelope);
        })
        .with({ type: "message.part" }, (e) => {
          // Persist every snapshot so an in-flight turn survives a session
          // switch or a reload; the frontend gets the data from the push.
          persistOnly(persistPart(e));
          pushEnvelope(envelope);
        })
        .with({ type: "message.part.delta" }, () => {
          // High-frequency streaming aid: forward-only, never persisted.
          // Snapshots are authoritative and reconstruct the same state.
          pushEnvelope(envelope);
        })
        .with({ type: "message.ended" }, (e) => {
          console.log(`[AgentEvent] message.ended: session=${sessionId} message=${e.messageId}`);
          // Bracket marker only — the parts are already durable and the turn's
          // accounting arrives on turn.ended.
          pushEnvelope(envelope);
        })

        // ── Diagnostics ───────────────────────────────────────────────────
        .with({ type: "error" }, (e) => {
          handleErrorEvent(sessionId, state, e);
          pushEnvelope(envelope);
        })

        // ── Not surfaced (yet) ────────────────────────────────────────────
        .with({ type: "permission.requested" }, { type: "permission.resolved" }, () => {
          // Tool policy answers permissions in-process (dont_ask + policy), so
          // there is no prompt to render. The events exist the day deus grows
          // a permission UI.
        })
        .with({ type: "raw" }, () => {
          // Opt-in passthrough; deus never sets RunConfig.includeRaw.
        })
        .exhaustive();
    },
  };
}

/**
 * A standalone `error` event. Recoverable errors mean the turn CONTINUES
 * (retry/backoff in flight) — promoting one would flip the UI to an error
 * state while the agent is still working AND suppress the real terminal error
 * through the dedupe flag. This swallow is load-bearing.
 */
function handleErrorEvent(sessionId: string, state: SessionState, event: ErrorEvent): void {
  if (event.recoverable) {
    console.warn(
      `[AgentEvent] recoverable error (turn continues): session=${sessionId} category=${event.category} ${event.message}`
    );
    return;
  }
  console.log(
    `[AgentEvent] error: session=${sessionId} category=${event.category} ${event.message}`
  );
  state.errorReported = true;
  persistAndInvalidate(
    persistSessionError(sessionId, event.message, event.category),
    SESSION_RESOURCES,
    sessionId
  );
  // The agent may have pushed a PR before the turn failed.
  refreshPrSnapshotForSession(sessionId);
}
