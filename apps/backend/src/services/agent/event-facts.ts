// backend/src/services/agent/event-facts.ts
// What one lifecycle event means to DEUS, apart from the rows.
//
// Two things live here, together, because both have exactly two consumers: the
// shipped handler and `apps/backend/cli.ts`, the harness that exists to verify
// it. A harness that verifies a re-implementation verifies nothing — and the
// CLI's own copy of this dispatch had already drifted: it never reset the
// per-turn error dedupe at `turn.started`, so a two-turn run silently swallowed
// the second turn's terminal error and still reported PASS.
//
//   describeEvent      — the one line a human reads per envelope.
//   applySessionFacts  — the session bookkeeping and the two session columns
//                        no `ConversationChange` accounts for.
//
// Neither invalidates a subscription, pushes a frame or refreshes a PR
// snapshot: those are the product's and stay in the handler. The writes come
// back so the caller can invalidate them (backend) or print them (CLI).

import { match } from "ts-pattern";
import { classifyError } from "@zvada/agent-server/protocol";
import type { ConversationTurn } from "@zvada/agent-server/protocol";
import { isUnknownEvent, type AnyLifecycleEvent } from "@shared/protocol-types";
import {
  persistAgentSessionId,
  persistSessionError,
  type TurnOutcomeWrite,
  type WriteResult,
} from "./persistence";

// ---- Session facts ----

/**
 * The per-session state deus keeps beside the engine's fold: which turn is
 * live, and whether its error was already reported. The conversation itself is
 * the reducer's — nothing here is derivable from it.
 */
export interface SessionFacts {
  /** The live turn — cleared at its turn.ended. */
  turnId?: string;
  /** One terminal error per turn: turn.ended(error) must not double-report. */
  errorReported: boolean;
}

/** A session-column write `applySessionFacts` performed. */
export interface SessionFactWrite {
  fact: "agent-session-id" | "session-error";
  result: WriteResult<void>;
}

/** The terminal state an ended turn leaves the session in. */
function turnOutcome(turn: ConversationTurn, alreadyReported: boolean): TurnOutcomeWrite {
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

/**
 * `turnOutcome`, plus the two flags an ended turn moves.
 *
 * This is the `outcomeFor` callback `persistChanges` takes, so deciding the
 * outcome and advancing the dedupe flag stay in step whichever event ended the
 * turn.
 */
export function turnOutcomeFor(facts: SessionFacts, turn: ConversationTurn): TurnOutcomeWrite {
  const outcome = turnOutcome(turn, facts.errorReported);
  if (facts.turnId === turn.turnId) facts.turnId = undefined;
  if (outcome.status === "error") facts.errorReported = true;
  return outcome;
}

/**
 * The session-scoped consequences of one event: the flags above, plus the two
 * columns the fold reports no change for because they are deus's rather than
 * the conversation's.
 *
 * A `session.ended` is deliberately absent — dropping the session's entry is
 * the owner of the map's decision, not this state's.
 */
export function applySessionFacts(
  facts: SessionFacts,
  sessionId: string,
  event: AnyLifecycleEvent
): SessionFactWrite[] {
  if (isUnknownEvent(event)) return [];

  return match(event)
    .with({ type: "session.created" }, (e): SessionFactWrite[] => {
      if (e.resumed === false) {
        // The harness was asked to continue a conversation and started a fresh
        // one instead: the context is gone. Silently swallowing this is how
        // "the agent forgot everything" becomes invisible.
        console.warn(
          `[AgentEvent] session ${sessionId} did NOT resume — the harness started a fresh session (context lost)`
        );
      }
      return [
        { fact: "agent-session-id", result: persistAgentSessionId(sessionId, e.nativeSessionId) },
      ];
    })
    .with({ type: "turn.started" }, (e): SessionFactWrite[] => {
      // Nothing to persist: status='working' was written optimistically by the
      // send command. Keep the admission mirror truthful on the replay path too
      // (state rebuilt after a backend restart has no turnId).
      facts.turnId = e.turnId;
      // A turn deus did NOT admit via beginTurn (replay, engine-initiated)
      // would otherwise inherit the previous turn's dedupe flag, and its
      // terminal error message would be dropped as "already reported".
      facts.errorReported = false;
      return [];
    })
    .with({ type: "error" }, (e): SessionFactWrite[] => {
      // A recoverable error means the turn CONTINUES (retry/backoff in
      // flight). Promoting one would flip the UI to an error state while the
      // agent is still working AND suppress the real terminal error through
      // the dedupe flag. This swallow is load-bearing.
      if (e.recoverable) return [];
      facts.errorReported = true;
      return [
        { fact: "session-error", result: persistSessionError(sessionId, e.message, e.category) },
      ];
    })
    .otherwise(() => []);
}

// ---- Description ----

/**
 * One lifecycle event → the detail a log line carries after its type.
 *
 * The single `.exhaustive()` over the union lives here: the day the engine
 * adds a member, this is what stops compiling, and every log sink learns to
 * describe it at once instead of printing a bare type.
 */
export function describeEvent(event: AnyLifecycleEvent): string {
  if (isUnknownEvent(event)) {
    return `unknown type ${JSON.stringify(event.raw).slice(0, 80)}`;
  }
  return match(event)
    .with(
      { type: "session.created" },
      (e) =>
        `native=${e.nativeSessionId} harness=${e.harness}${e.resumed === false ? " resumed=false" : ""}`
    )
    .with({ type: "session.ended" }, (e) => `reason=${e.reason}`)
    .with({ type: "turn.started" }, (e) => `turn=${e.turnId}`)
    .with(
      { type: "turn.ended" },
      (e) => `turn=${e.turnId} stopReason=${e.stopReason} cost=${e.cost ?? 0}`
    )
    .with(
      { type: "message.started" },
      (e) => `message=${e.messageId} role=${e.role} turn=${e.turnId}`
    )
    .with({ type: "message.part" }, (e) => `${e.part.type} partId=${e.part.id}`)
    .with({ type: "message.part.delta" }, (e) => `${e.delta.type} partId=${e.partId}`)
    .with({ type: "message.ended" }, (e) => `message=${e.messageId}`)
    .with(
      { type: "session.usage" },
      (e) => `used=${e.used}${e.size !== undefined ? `/${e.size}` : ""}`
    )
    .with({ type: "session.compaction" }, (e) => `id=${e.compactionId} status=${e.status}`)
    .with(
      { type: "error" },
      (e) =>
        `category=${e.category}${e.recoverable ? " (recoverable — the turn continues)" : ""} ${e.message}`
    )
    .with({ type: "permission.requested" }, (e) => `requestId=${e.requestId} "${e.title}"`)
    .with({ type: "permission.resolved" }, (e) => `requestId=${e.requestId}`)
    .with({ type: "raw" }, (e) => `harness=${e.harness}`)
    .exhaustive();
}
