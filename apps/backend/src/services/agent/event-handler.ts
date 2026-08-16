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
// about any of those, so they live in `event-facts.ts` — with the log line —
// where `apps/backend/cli.ts` drives the same dispatch instead of a copy of it.
// What is left here is the plumbing only the server has: invalidation, the WS
// push, the PR snapshot and the session map.
//
// Ordering matters: persist first, then invalidate, then push.

import { match } from "ts-pattern";
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import type { ConversationChange, ConversationState } from "@zvada/agent-server/protocol";
import { isUnknownEvent, type DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { QueryResource, QServerFrame } from "@shared/types/query-protocol";
import { invalidate } from "../query-engine";
import { broadcast } from "../ws.service";
import { persistChanges, persistSessionTitle, type WriteResult } from "./persistence";
import { applySessionFacts, describeEvent, turnOutcomeFor, type SessionFacts } from "./event-facts";
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
  /**
   * The turn this handler currently believes is running, if any — set at
   * admission (or at `turn.started` on the replay path) and cleared at its
   * `turn.ended`. Read by anything that has to tell one turn from the next,
   * which a session STATUS cannot do: two consecutive turns are both "working".
   */
  liveTurnId(sessionId: string): string | undefined;
  /** Side-channel title notification (deus/*, not a lifecycle event). */
  handleTitle(sessionId: string, title: string): void;
}

interface SessionState extends SessionFacts {
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
 * `turn.started` could arrive, the ClaudeToolPolicy in
 * apps/agent-server/agents/core/tool-policy.ts answers every tool-use
 * question in-process (deus has no interactive permission UI, so nothing may
 * fall through to the engine's broker), and deus never sets
 * `RunConfig.includeRaw`.
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
 *
 * `message-upserted` KEEPS `messages` even though the same argument nearly
 * applies (the fold projects `message.started` from the pushed envelope for
 * the live session and for every background one with a cached page). Reviewed
 * and left in place deliberately: the two paths have not been shown equivalent
 * at runtime for a client that reconnects mid-turn or subscribes before its
 * page resolves, and `mergeMessageDelta` dedupes by id, so the redundant case
 * costs a query and a frame while the missing case would cost a lost row.
 * Whoever exercises those two paths can drop `"messages"` here and make the
 * fold the single writer of message rows — note that `invalidate` fans a
 * `messages` push out to EVERY subscribed session, not just the changed one
 * (query-engine.ts: the `ctx.sessionIds` filter covers `session`/`workspaces`,
 * not `messages`), so the saving is per subscription, not per client.
 */
const INVALIDATED_BY: Partial<Record<ConversationChange["kind"], QueryResource[]>> = {
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

    liveTurnId(sessionId) {
      return sessions.get(sessionId)?.turnId;
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

      // One line per envelope, from the same describer the verification CLI
      // prints. Parts are the exception: `message.part` is already accounted
      // for by the change log below, and `message.part.delta` arrives per
      // TOKEN — describing either would drown the log it belongs to.
      if (envelope.event.type !== "message.part" && envelope.event.type !== "message.part.delta") {
        console.log(
          `[AgentEvent] ${envelope.event.type}: session=${sessionId} ${describeEvent(envelope.event)}`
        );
      }

      // ── The rows the conversation moved ─────────────────────────────────
      // Deltas are forward-only (§04-C2): the fold keeps them current in
      // `state`, the frontend batches them per animation frame, and the DB
      // stays at snapshot granularity — the authoritative `message.part` that
      // follows carries the settled value. Persisting the part-upserted a
      // delta reports would be one full-JSON row write PER TOKEN on the WS
      // hot path (measured: 200 deltas → 200 writes, ~169 KB for a 1.7 KB
      // message), for durability the protocol explicitly does not promise.
      const isDelta = envelope.event.type === "message.part.delta";
      const writes = isDelta
        ? []
        : persistChanges(sessionId, conversation, changes, (turn) => turnOutcomeFor(state, turn));

      const stale = new Set<QueryResource>();
      for (const write of writes) {
        if (!write.result.ok) {
          console.warn(
            `[AgentEvent] Persistence failed (${write.change.kind}):`,
            write.result.error
          );
          continue;
        }
        for (const resource of INVALIDATED_BY[write.change.kind] ?? []) stale.add(resource);
      }
      if (stale.size > 0) invalidate([...stale], { sessionIds: [sessionId] });

      // ── The facts that are deus's, not the conversation's ───────────────
      // The session columns and the per-turn flags are `applySessionFacts`'s,
      // shared verbatim with the verification CLI. What is left below is the
      // product plumbing only this process has.
      for (const write of applySessionFacts(state, sessionId, envelope.event)) {
        persistAndInvalidate(write.result, SESSION_RESOURCES, sessionId);
      }

      match(envelope.event)
        .with({ type: "session.ended" }, () => {
          // The session is over — drop its state, folded transcript included.
          // This is the event that exists for exactly that; without it the map
          // only grows, and now each entry costs a conversation.
          sessions.delete(sessionId);
        })
        .with({ type: "turn.ended" }, () => {
          // The agent may have created, updated or pushed a PR during the turn.
          refreshPrSnapshotForSession(sessionId);
        })
        .with({ type: "error" }, (e) => {
          // A recoverable error means the turn is still running (and
          // `applySessionFacts` swallowed it) — there is nothing new to look at
          // yet. A terminal one may have followed a PR push.
          if (!e.recoverable) refreshPrSnapshotForSession(sessionId);
        })
        // Everything else is fully described by the changes above. No
        // `.exhaustive()`: the tripwire for a new event member is
        // `describeEvent`, which must name every one of them.
        .otherwise(() => {});

      if (!NOT_PUSHED.has(envelope.event.type)) pushEnvelope(envelope);
    },
  };
}
