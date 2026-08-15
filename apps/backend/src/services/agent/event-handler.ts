// backend/src/services/agent/event-handler.ts
// The single entry point for agent → backend data flow.
//
// It consumes the @zvada/agent-server lifecycle stream NATIVELY: the envelope
// goes into the engine's own fold, the fold reports what moved, and
// `persistChanges` turns that into rows. There is no translation layer — the
// event that crosses the wire is the event the frontend folds, with the SAME
// reducer, projecting onto the TanStack cache instead of SQLite.
//
// What is NOT change-driven is the small set of facts that are deus's rather
// than the conversation's: which turn is admitted, whether an error was already
// reported for it, and the session STATUS that results. The fold has no opinion
// about any of those, so they stay an explicit switch.
//
// Ordering matters: persist first, then invalidate, then push.

import { match } from "ts-pattern";
import {
  classifyError,
  emptyConversation,
  reduceConversationWithChanges,
} from "@zvada/agent-server/protocol";
import type { ConversationState, ConversationTurn, ErrorEvent } from "@zvada/agent-server/protocol";
import { isUnknownEvent, type DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { QueryResource, QServerFrame } from "@shared/types/query-protocol";
import { invalidate } from "../query-engine";
import { broadcast } from "../ws.service";
import {
  persistAgentSessionId,
  persistChanges,
  persistSessionError,
  persistSessionTitle,
  type ChangeWrite,
  type TurnOutcomeWrite,
  type WriteResult,
} from "./persistence";
import { refreshPrSnapshotForSession } from "../pr-snapshot.service";

// ---- Types ----

export interface AgentEventHandler {
  /** Feed one sequenced wire envelope (post-dedupe, in seq order). */
  handle(envelope: DecodedWireEventEnvelope): void;
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
  /** The folded conversation — the source of every row this session writes. */
  conversation: ConversationState;
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

/**
 * The events the frontend does NOT receive.
 *
 * Everything else is pushed verbatim, because the frontend folds it. These
 * five reach the UI another way or not at all: the context gauge and the
 * session's terminal state are session COLUMNS (q:delta carries them), the
 * "working" flip is written optimistically by the send command before
 * `turn.started` could arrive, tool policy answers permissions in-process so
 * there is no prompt to render, and deus never sets `RunConfig.includeRaw`.
 */
const NOT_PUSHED = new Set([
  "session.ended",
  "session.usage",
  "turn.started",
  "permission.requested",
  "permission.resolved",
  "raw",
]);

/**
 * What a successful write of each change kind makes stale.
 *
 * `part-upserted` is deliberately absent: the frontend already has the part
 * from the pushed envelope, so a q:delta would only run a wasted query.
 */
const INVALIDATED_BY: Partial<Record<ChangeWrite["kind"], QueryResource[]>> = {
  "message-upserted": MESSAGE_RESOURCES,
  "turn-updated": TURN_END_RESOURCES,
  "usage-updated": SESSION_RESOURCES,
  "compaction-upserted": MESSAGE_RESOURCES,
};

// ---- Helpers ----

/** Persist a write and invalidate subscriptions if it succeeded. */
function persistAndInvalidate(
  result: WriteResult<unknown>,
  resources: QueryResource[],
  sessionId: string
): void {
  if (result.ok) {
    invalidate(resources, { sessionIds: [sessionId] });
  }
}

/**
 * Push one wire envelope to every frontend connection verbatim. The frontend
 * routes by `sessionId` and orders/dedupes by `seq` — both free because the
 * envelope is not reshaped on its way through the backend.
 */
function pushEnvelope(envelope: DecodedWireEventEnvelope): void {
  const frame: QServerFrame = { type: "q:event", event: "agent:event", data: envelope };
  broadcast(JSON.stringify(frame));
}

/** The terminal state an ended turn leaves the session in. Exported so the
 *  verification CLI decides it the same way instead of re-deriving it. */
export function turnOutcome(turn: ConversationTurn, alreadyReported: boolean): TurnOutcomeWrite {
  if (turn.stopReason === "cancelled") {
    return { status: "idle", cancelled: true };
  }
  if (turn.stopReason === "error") {
    // A standalone `error` event already wrote the status + message; the
    // terminal event must not overwrite it with a vaguer one.
    if (alreadyReported) return { status: "error", cancelled: false };
    const message = turn.error?.message ?? "Agent turn failed";
    return {
      status: "error",
      cancelled: false,
      error: { message, category: turn.error?.category ?? classifyError(new Error(message)) },
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
    const created: SessionState = { errorReported: false, conversation: emptyConversation() };
    sessions.set(sessionId, created);
    return created;
  };

  return {
    beginTurn(sessionId, turnId, opts = {}) {
      const existing = sessions.get(sessionId);
      if (existing?.turnId !== undefined && !opts.force) return false;
      sessions.set(sessionId, {
        turnId,
        errorReported: false,
        // The transcript outlives the turn: a new send continues the session's
        // conversation, it does not start a second one.
        conversation: existing?.conversation ?? emptyConversation(),
      });
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

      // The fold takes the union as-is, unknown types included (they land in
      // `state.unknownEvents`, in arrival order) and reports no row changes for
      // them: deus knows no columns for a shape it cannot read.
      const { state: conversation, changes } = reduceConversationWithChanges(
        state.conversation,
        envelope.event
      );
      state.conversation = conversation;

      if (isUnknownEvent(envelope.event)) {
        // Law 6: forward it verbatim. Dropping it would be a hole in the
        // frontend's transcript and a fabricated seq gap for anything counting
        // envelopes.
        console.warn(
          `[AgentEvent] unknown event type: session=${sessionId} ${envelope.event.type}`
        );
        pushEnvelope(envelope);
        return;
      }

      // ── The rows the conversation moved ─────────────────────────────────
      const writes = persistChanges(sessionId, conversation, changes, (turn) => {
        // Deciding (and recording) the outcome here keeps the dedupe flag in
        // step with the write it guards, whichever event ended the turn.
        const outcome = turnOutcome(turn, state.errorReported);
        if (state.turnId === turn.turnId) state.turnId = undefined;
        if (outcome.status === "error") state.errorReported = true;
        return outcome;
      });

      const stale = new Set<QueryResource>();
      for (const write of writes) {
        if (!write.result.ok) {
          console.warn(`[AgentEvent] Persistence failed (${write.kind}):`, write.result.error);
          continue;
        }
        for (const resource of INVALIDATED_BY[write.kind] ?? []) stale.add(resource);
      }
      if (stale.size > 0) invalidate([...stale], { sessionIds: [sessionId] });

      // ── The facts that are deus's, not the conversation's ───────────────
      match(envelope.event)
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
        })
        .with({ type: "session.ended" }, (e) => {
          console.log(`[AgentEvent] session.ended: session=${sessionId} reason=${e.reason}`);
          // The session is over — drop its state, folded transcript included.
          // This is the event that exists for exactly that; without it the map
          // only grows, and now each entry costs a conversation.
          sessions.delete(sessionId);
        })
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
          // The agent may have created, updated or pushed a PR during the turn.
          refreshPrSnapshotForSession(sessionId);
        })
        .with({ type: "message.started" }, (e) => {
          console.log(
            `[AgentEvent] message.started: session=${sessionId} message=${e.messageId} role=${e.role} turn=${e.turnId}`
          );
        })
        .with({ type: "message.ended" }, (e) => {
          console.log(`[AgentEvent] message.ended: session=${sessionId} message=${e.messageId}`);
        })
        .with({ type: "session.compaction" }, (e) => {
          console.log(
            `[AgentEvent] session.compaction: session=${sessionId} id=${e.compactionId} status=${e.status}`
          );
        })
        .with({ type: "error" }, (e) => {
          handleErrorEvent(sessionId, state, e);
        })
        .with(
          { type: "message.part" },
          { type: "message.part.delta" },
          { type: "session.usage" },
          { type: "permission.requested" },
          { type: "permission.resolved" },
          { type: "raw" },
          () => {
            // Fully described by the changes above, or — for permission.* and
            // raw — nothing deus surfaces: tool policy answers permissions
            // in-process (dont_ask + policy) so there is no prompt to render,
            // and deus never sets RunConfig.includeRaw.
          }
        )
        .exhaustive();

      if (!NOT_PUSHED.has(envelope.event.type)) pushEnvelope(envelope);
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
