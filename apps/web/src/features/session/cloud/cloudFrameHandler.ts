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
import type { AnyLifecycleEvent } from "@shared/protocol-types";
import { projectCloudSnapshot } from "@shared/cloud-session-snapshot";
import {
  foldEvent,
  commitTranscriptOrder,
  patchSessionDetail,
  type AgentStreamContext,
} from "../lib/agentEventFold";
import { bustCloudSessionsListCache } from "./cloudDataAdapter";
import { notifyCloudAutosaveFailure } from "./notifyCloudAutosaveFailure";

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set(LIFECYCLE_EVENT_TYPES);

/**
 * Build the frame sink for one direct-agnt socket. agnt session frames carry no
 * wire `seq`, so — unlike the Mac `q:` lane — there is no cursor to feed: the
 * gap/reset/duplicate arithmetic can't fire on a lane with no seq, and a
 * reconnect heals by re-folding the fresh snapshot (upsert-by-id), not by a
 * cursor reset. So each frame folds straight through `foldEvent`.
 */
export function makeCloudFrameHandler(
  ctx: AgentStreamContext,
  sessionId: string
): (frame: Record<string, unknown>) => void {
  const route = (event: AnyLifecycleEvent): void => {
    // The deus session id is the fold's key everywhere; the wire carries the
    // agnt PROVIDER id, so rewrite it exactly as the backend driver's
    // `pushToFold` does.
    const withSession = {
      ...(event as Record<string, unknown>),
      sessionId,
    } as AnyLifecycleEvent;
    foldEvent(ctx, sessionId, withSession);
  };

  return (frame: Record<string, unknown>): void => {
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type === "session.snapshot") {
      backfillSnapshot(frame as unknown as SessionSnapshotEvent, ctx, sessionId, route);
      return;
    }
    // Category-bearing `error` frames are the engine's error events (the
    // reducer records them on their turn); category-less ones are command
    // rejections the socket hook consumes. Same split as the Mac driver's
    // `pushToFold` gate.
    const isEngineError =
      type === "error" && typeof (frame as { category?: unknown }).category === "string";
    if (LIFECYCLE_TYPES.has(type) || isEngineError) {
      route(frame as unknown as AnyLifecycleEvent);
      if (type === "turn.ended") notifyCloudAutosaveFailure(frame);
      // The direct lane has no q: push keeping `sessions.detail` fresh, so the
      // working indicator / Stop button would never move — project the turn
      // lifecycle onto the row here (the Mac lane gets this from the backend).
      if (type === "turn.started" || type === "turn.ended") {
        // A terminal error can arrive as `stopReason: "error"` with NO inline
        // error object (the backend classifies that shape as an internal
        // error) — status must follow the stop reason, not just the payload.
        const { error, stopReason } = frame as { error?: unknown; stopReason?: unknown };
        patchSessionDetail(
          ctx.queryClient,
          sessionId,
          type === "turn.started"
            ? { status: "working" }
            : { status: error || stopReason === "error" ? "error" : "idle" }
        );
        // The SIDEBAR row reads the workspaces list, not sessions.detail — a
        // turn boundary is rare enough that a list refetch is the simple way to
        // move its working dot without inventing a push channel. Bust the
        // adapter's in-flight list cache first: a boundary inside its 3s TTL
        // would otherwise refetch the CACHED list and the dot wouldn't move
        // until the next slow tick.
        bustCloudSessionsListCache();
        void ctx.queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      } else if (type === "session.usage") {
        // The composer's context gauge — mirror the Mac backend's projection
        // (persistUsage): count always, percent only when a size is known.
        const { used, size } = frame as { used?: number; size?: number };
        if (typeof used === "number") {
          patchSessionDetail(ctx.queryClient, sessionId, {
            context_token_count: used,
            ...(size ? { context_used_percent: Math.min((used / size) * 100, 100) } : {}),
          });
        }
      }
    }
    // else: a non-render frame — see the file header.
  };
}

/**
 * Unroll the snapshot's already-folded transcript back into the event stream
 * that produced it, then restate each ended turn's accounting and every
 * historical compaction. Rows first (the messages), then `turn.ended` and
 * `session.compaction` — so both land on a transcript that exists — and finally
 * one commit that fixes the render ORDER.
 */
function backfillSnapshot(
  snapshot: SessionSnapshotEvent,
  ctx: AgentStreamContext,
  sessionId: string,
  route: (event: AnyLifecycleEvent) => void
): void {
  const { events, messageIds } = projectCloudSnapshot(snapshot);
  for (const event of events) route(event);
  const currentTurnId = snapshot.state.currentTurnId ?? null;

  // Commit the transcript ORDER. The fold APPENDS a message whose id it has not
  // seen, so if the user sent before this snapshot arrived, the optimistic
  // prompt is already first and the unrolled history landed AFTER it. Reorder
  // once: snapshot rows in `messageIndex` order, then any row the snapshot does
  // not know (an optimistic bubble, a mid-flight live row) after them, in place.
  // Idempotent on reconnect — a second snapshot with the same ids is a no-op.
  commitTranscriptOrder(ctx.queryClient, sessionId, messageIds);

  // Restate the snapshot's session facts onto the detail row (web-direct has no
  // q: push): a live turn means working NOW, the real message count fixes
  // discovery's zero (which otherwise mislabels an old conversation "New chat"),
  // and the context gauge resumes from where the session left off.
  const contextUsed = snapshot.state.contextUsed;
  const contextSize = snapshot.state.contextSize;
  patchSessionDetail(ctx.queryClient, sessionId, {
    status: currentTurnId ? "working" : snapshot.state.status === "error" ? "error" : "idle",
    message_count: messageIds.length,
    ...(typeof contextUsed === "number"
      ? {
          context_token_count: contextUsed,
          ...(contextSize
            ? { context_used_percent: Math.min((contextUsed / contextSize) * 100, 100) }
            : {}),
        }
      : {}),
  });
}
