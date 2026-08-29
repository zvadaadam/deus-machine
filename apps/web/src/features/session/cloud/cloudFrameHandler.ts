// apps/web/src/features/session/cloud/cloudFrameHandler.ts
// The direct-agnt lane's frame → fold adapter, factored out of the React hook
// so it is unit-testable without a DOM or a socket (the same reason the fold
// itself lives outside `useAgentEvents`).
//
// It is the browser twin of the backend's `agent/cloud/driver.ts`: one raw agnt
// session frame in, one `DecodedWireEventEnvelope` handed to the shared fold. The
// backend calls `handler.handle(envelope)`; here the equivalent sink is the
// renderer's `routeEnvelope(ctx, envelope)` — same envelope, same synthetic
// per-session `seq`, same deus-session-id rewrite.
//
// Two frame classes matter to a RENDER slice:
//
//   session.snapshot — agnt's replay envelope, sent on every (re)connect. It
//     carries the transcript as an already-folded `Message[]` (`snapshot.messages`)
//     plus per-turn accounting (`snapshot.state.turns`). It is NOT a replayable
//     lifecycle-event log: the snapshot's `events` array is filtered server-side
//     to workspace-lifecycle chatter, so the transcript is reconstructed here by
//     unrolling each message back into the `message.started` + `message.part`
//     events that produced it (agnt's own SDK seeds from the same `Message[]`).
//   lifecycle events — message.started / message.part / message.part.delta /
//     turn.* / session.* — folded verbatim, as the live stream.
//
// Everything else (workspace.state, pty.*, diff.*, fs.*, browser.*, session.error,
// permission.request, mcp.question) is a backend-driver effect with no surface in
// a pure render lane, and is ignored.

import { LIFECYCLE_EVENT_TYPES } from "@deus-hq/api";
import type { SessionSnapshotEvent } from "@deus-hq/api";
import type { AnyLifecycleEvent, DecodedWireEventEnvelope } from "@shared/protocol-types";
import { routeEnvelope, type AgentStreamContext } from "../lib/agentEventFold";

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set(LIFECYCLE_EVENT_TYPES);

type SnapshotMessage = NonNullable<SessionSnapshotEvent["messages"]>[number];
type SnapshotPart = SnapshotMessage["parts"][number];
type SnapshotTurn = NonNullable<SessionSnapshotEvent["state"]["turns"]>[number];

/** A fresh per-handler seq counter — the default when no persistent one is given. */
function localSeqSource(): () => number {
  let seq = 0;
  return () => ++seq;
}

/**
 * A frame sink. The synthetic `seq` it stamps must be monotonic ACROSS the
 * fold's cursor lifetime, not just this handler's — the cursor is module-level
 * (it survives panel remounts) while a handler is per-connection. If the seq
 * reset to 0 on every remount, the next snapshot's first envelope (seq 1) would
 * read as a fresh log to a cursor already past 1, forcing a spurious reset +
 * refetch each time. So the hook supplies a PERSISTENT per-session `nextSeq`
 * whose lifetime matches the cursor's; the default is only for standalone use
 * (tests). Either way the envelopes are contiguous and monotonic across the
 * snapshot backfill and the live stream, and a reconnect's fresh snapshot simply
 * re-folds under ever-higher seqs — upsert-by-id, idempotent.
 */
export function makeCloudFrameHandler(
  ctx: AgentStreamContext,
  sessionId: string,
  nextSeq: () => number = localSeqSource()
): (frame: Record<string, unknown>) => void {
  const route = (event: AnyLifecycleEvent): void => {
    // The deus session id is the fold's key everywhere (cache, cursor, the
    // active-session check); the wire carries the agnt PROVIDER id, so rewrite
    // it exactly as the backend driver's `pushToFold` does.
    const withSession = {
      ...(event as Record<string, unknown>),
      sessionId,
    } as AnyLifecycleEvent;
    routeEnvelope(ctx, {
      sessionId,
      seq: nextSeq(),
      event: withSession,
    } as DecodedWireEventEnvelope);
  };

  return (frame: Record<string, unknown>): void => {
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type === "session.snapshot") {
      backfillSnapshot(frame as unknown as SessionSnapshotEvent, route);
      return;
    }
    if (LIFECYCLE_TYPES.has(type)) {
      route(frame as unknown as AnyLifecycleEvent);
    }
    // else: a non-render frame — see the file header.
  };
}

/**
 * Unroll the snapshot's already-folded transcript back into the event stream
 * that produced it, then restate each ended turn's accounting. Rows first (the
 * messages), then `turn.ended` — so accounting lands on a row that exists.
 */
function backfillSnapshot(
  snapshot: SessionSnapshotEvent,
  route: (event: AnyLifecycleEvent) => void
): void {
  const messages = snapshot.messages ?? [];
  // `messageIndex` is the session-scoped ordinal; folding in that order lands
  // the reconstructed rows in transcript order.
  const ordered = [...messages].sort((a, b) => a.messageIndex - b.messageIndex);
  for (const message of ordered) {
    route(messageStartedEvent(message));
    message.parts.forEach((part, partIndex) => route(messagePartEvent(message, part, partIndex)));
  }

  // The live turn's accounting arrives on the live stream as its own
  // `turn.ended`; only the already-ended turns need restating from the snapshot.
  const currentTurnId = snapshot.state.currentTurnId ?? null;
  for (const turn of snapshot.state.turns ?? []) {
    if (turn.turnId === currentTurnId) continue;
    route(turnEndedEvent(turn));
  }
}

function messageStartedEvent(message: SnapshotMessage): AnyLifecycleEvent {
  const base = {
    type: "message.started",
    sessionId: message.sessionId,
    turnId: message.turnId,
    messageId: message.id,
    outputIndex: message.outputIndex,
    role: message.role,
    timestamp: message.createdAt,
  };
  // `model` and `parentToolCallId` live only on the assistant variant; the
  // reducer omits them when absent rather than nulling a persisted value.
  if (message.role === "assistant") {
    return {
      ...base,
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.parentToolCallId !== undefined
        ? { parentToolCallId: message.parentToolCallId }
        : {}),
    } as unknown as AnyLifecycleEvent;
  }
  return base as unknown as AnyLifecycleEvent;
}

function messagePartEvent(
  message: SnapshotMessage,
  part: SnapshotPart,
  partIndex: number
): AnyLifecycleEvent {
  return {
    type: "message.part",
    sessionId: message.sessionId,
    turnId: message.turnId,
    messageId: message.id,
    outputIndex: message.outputIndex,
    partIndex,
    part,
    timestamp: message.createdAt,
  } as unknown as AnyLifecycleEvent;
}

function turnEndedEvent(turn: SnapshotTurn): AnyLifecycleEvent {
  return {
    type: "turn.ended",
    sessionId: null,
    turnId: turn.turnId,
    stopReason: turn.stopReason,
    timestamp: turn.endedAt,
    ...(turn.tokens !== undefined ? { tokens: turn.tokens } : {}),
    ...(turn.cost !== undefined ? { cost: turn.cost } : {}),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  } as unknown as AnyLifecycleEvent;
}
