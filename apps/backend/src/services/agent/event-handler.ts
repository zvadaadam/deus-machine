import { turnProviderCredentialSource } from "@shared/conversation-rows";
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
import type { SessionEventGap } from "@zvada/agent-server/client";
import type { SessionSnapshotEvent } from "@deus-hq/api";
import type { RestoredCloudConversation } from "@shared/cloud-session-snapshot";
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import type { ConversationChange, ConversationState } from "@zvada/agent-server/protocol";
import {
  isLiveEnvelope,
  isUnknownEvent,
  type DecodedWireEventEnvelope,
} from "@shared/protocol-types";
import type { LiveName } from "@shared/api";
import { cloudSaveFailures, sessionEvents } from "@shared/api/sessions";
import { cloudSaveFailure } from "@shared/cloud-autosave";
import { invalidate } from "../query-engine";
import { openWith, publish } from "../streams";
import {
  persistChanges,
  persistSessionTitle,
  persistSessionError,
  type WriteResult,
} from "./persistence";
import { pushCloudSessionTitle } from "./cloud/driver";
import { applySessionFacts, describeEvent, turnOutcomeFor, type SessionFacts } from "./event-facts";
import { refreshPrSnapshotForSession } from "../pr-snapshot.service";
import { restoreCloudSnapshot } from "./cloud/snapshot";
import { OpenParts } from "./open-parts";

// ---- Types ----

export interface AgentEventHandler {
  /** Feed one sequenced wire envelope (post-dedupe, in seq order). */
  handle(envelope: DecodedWireEventEnvelope): void;
  /** Restore durable cloud history without executing historical live effects. */
  hydrateCloudSnapshot(
    sessionId: string,
    snapshot: SessionSnapshotEvent
  ): RestoredCloudConversation | undefined;
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
  /** Release a rejected local claim, only while this turn is still unadmitted. */
  abortTurn(sessionId: string, turnId: string): boolean;
  /**
   * The turn this handler currently believes is running, if any — set at
   * admission (or at `turn.started` on the replay path) and cleared at its
   * `turn.ended`. Read by anything that has to tell one turn from the next,
   * which a session STATUS cannot do: two consecutive turns are both "working".
   */
  liveTurnId(sessionId: string): string | undefined;
  /** Records the quick ACK, including turns with no first event yet. */
  confirmTurn(sessionId: string, turnId: string): void;
  /** Mark delivery loss synchronously, before any replay suffix is folded. */
  handleEventGap(gap: SessionEventGap): string | undefined;
  /** Settle only that damaged turn after targeted native reconciliation. */
  settleEventGap(sessionId: string, turnId: string, confirmed: boolean): void;
  /** Side-channel title notification (deus/*, not a lifecycle event). */
  handleTitle(sessionId: string, title: string): void;
}

interface SessionState extends SessionFacts {
  /** The folded conversation — the source of every row this session writes. */
  conversation: ConversationState;
}

// ---- Resource groups for invalidation ----

const SESSION_RESOURCES: LiveName[] = ["workspaces", "sessions", "session", "stats"];
/** A message or a compaction row was written: the session's own row counts them. */
const TRANSCRIPT_RESOURCES: LiveName[] = ["session"];

/**
 * The events the frontend does NOT receive.
 *
 * Everything else is published verbatim, because the frontend folds it. These
 * reach the UI another way or not at all: the context gauge and the session's
 * terminal state are session COLUMNS (the `session` read carries them), the
 * service answers a permission request (a plan goes to the plan card as a
 * request on `toolRequests`, a tool's approval is allowed:
 * shared/agent-permissions.ts), and deus never sets `RunConfig.includeRaw`.
 *
 * `turn.started` IS published: it is where a turn's start time and what it
 * runs on come from, and a client has no other source for them while the turn
 * is live (the transcript page is read once, then only the stream changes it).
 */
const NOT_PUSHED = new Set([
  "session.ended",
  "session.usage",
  "permission.requested",
  "permission.resolved",
  "raw",
]);

/**
 * What a successful write of each change kind makes stale.
 *
 * The transcript itself is never among them: a client folds the published
 * envelope into its page (rows, parts, turns), so the chat's stream is the one
 * way a transcript changes on a client. The stream resumes for a client that
 * was away, or tells it to read the page again. What is invalidated here are
 * the reads that summarize a chat: its row, its workspace, the counts.
 */
const INVALIDATED_BY: Partial<Record<ConversationChange["kind"], LiveName[]>> = {
  message_upserted: TRANSCRIPT_RESOURCES,
  turn_updated: SESSION_RESOURCES,
  usage_updated: SESSION_RESOURCES,
  compaction_upserted: TRANSCRIPT_RESOURCES,
};

// ---- Helpers ----

/** Persist a write and invalidate subscriptions if it succeeded. */
function persistAndInvalidate(
  result: WriteResult<unknown>,
  resources: LiveName[],
  sessionId: string
): void {
  if (result.ok) {
    invalidate(resources, { sessionIds: [sessionId] });
  }
}

/**
 * Send one wire envelope, verbatim, to the clients following its chat. A token
 * delta is delivered but not kept: a client that was away never needs it, the
 * part's next event restates what it streamed.
 */
function pushEnvelope(envelope: DecodedWireEventEnvelope): void {
  publish(
    sessionEvents,
    { sessionId: envelope.sessionId },
    { type: "event", envelope },
    { keep: !isLiveEnvelope(envelope) }
  );
}

// ---- Factory ----

/** Create the agent event handler: persistence + WS push per lifecycle event. */
export function createAgentEventHandler(): AgentEventHandler {
  const sessions = new Map<string, SessionState>();
  // A client that starts following a chat, or returns to it, first gets the
  // reply still being typed as it stands (see ./open-parts).
  const typing = new OpenParts();
  openWith(sessionEvents, ({ sessionId }) =>
    typing.of(sessionId, sessions.get(sessionId)?.conversation)
  );

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = { errorReported: false, conversation: emptyConversation() };
    sessions.set(sessionId, created);
    return created;
  };

  return {
    hydrateCloudSnapshot(sessionId, snapshot) {
      const state = stateFor(sessionId);
      const pending =
        state.turnId !== undefined &&
        !state.conversation.turns.some((turn) => turn.turnId === state.turnId) &&
        snapshot.state.currentTurnId !== state.turnId &&
        !snapshot.state.turns?.some((turn) => turn.turnId === state.turnId);
      const result = restoreCloudSnapshot(sessionId, snapshot, pending);
      if (!result.ok) {
        console.warn(
          `[AgentEvent] Cloud history restore failed: session=${sessionId}`,
          result.error
        );
        return;
      }
      state.conversation = result.value.conversation;
      if (!pending) {
        state.turnId = snapshot.state.currentTurnId ?? undefined;
        state.errorReported = snapshot.state.status === "error";
      }
      invalidate(SESSION_RESOURCES, { sessionIds: [sessionId] });
      return result.value;
    },

    beginTurn(sessionId, turnId, opts = {}) {
      const existing = sessions.get(sessionId);
      if (existing?.turnId !== undefined && !opts.force) return false;
      sessions.set(sessionId, {
        turnId,
        acceptedTurnId: existing?.acceptedTurnId,
        errorReported: false,
        // The transcript outlives the turn: a new send continues the session's
        // conversation, it does not start a second one.
        conversation: existing?.conversation ?? emptyConversation(),
      });
      return true;
    },

    abortTurn(sessionId, turnId) {
      const state = sessions.get(sessionId);
      if (
        state?.turnId !== turnId ||
        state.acceptedTurnId === turnId ||
        state.conversation.turns.some((turn) => turn.turnId === turnId)
      ) {
        return false;
      }
      state.turnId = undefined;
      return true;
    },

    liveTurnId(sessionId) {
      return sessions.get(sessionId)?.turnId;
    },

    confirmTurn(sessionId, turnId) {
      const state = sessions.get(sessionId);
      if (!state) return;
      // An instant native turn can finish before its quick ACK returns.
      if (
        state.turnId === turnId ||
        (!state.turnId && state.conversation.turns.at(-1)?.turnId === turnId)
      )
        state.acceptedTurnId = turnId;
    },

    handleEventGap(gap) {
      const state = sessions.get(gap.sessionId);
      if (!state?.turnId) return;
      // A new send waiting for the reconnect handshake is not an old native
      // turn. Its quick ACK or rejection still owns that admission.
      if (
        state.acceptedTurnId !== state.turnId &&
        !state.conversation.turns.some((turn) => turn.turnId === state.turnId)
      )
        return;
      const turnId = state.turnId;
      state.deliveryFailure ??= {
        turnId,
        message:
          "Some agent output could not be recovered. This turn's transcript is incomplete; inspect partial work before retrying.",
      };
      console.warn(
        `[AgentEvent] Incomplete delivery: session=${gap.sessionId} turn=${turnId} reason=${gap.reason}`
      );
      if (gap.reason === "server_restarted" || gap.reason === "session_missing") {
        this.settleEventGap(gap.sessionId, turnId, true);
        return;
      }
      return turnId;
    },

    settleEventGap(sessionId, turnId, confirmed) {
      const state = sessions.get(sessionId);
      if (state?.turnId !== turnId || state.deliveryFailure?.turnId !== turnId) return;
      const message =
        state.deliveryFailure.message +
        (confirmed ? "" : " The agent has not confirmed it stopped.");
      if (confirmed) state.turnId = undefined;
      state.errorReported = true;
      persistAndInvalidate(
        persistSessionError(sessionId, message, "network", confirmed ? "error" : "working"),
        SESSION_RESOURCES,
        sessionId
      );
    },

    handleTitle(sessionId, title) {
      console.log(`[AgentEvent] deus/title: session=${sessionId} title="${title}"`);
      persistAndInvalidate(persistSessionTitle(sessionId, title), SESSION_RESOURCES, sessionId);
      // The cloud twin carries the title too — that's what the Mac-closed web lists.
      pushCloudSessionTitle(sessionId, title);
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
      typing.saw(envelope);

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
        : persistChanges(
            sessionId,
            conversation,
            changes,
            (turn) => turnOutcomeFor(state, turn),
            turnProviderCredentialSource(envelope.event)
          );

      const stale = new Set<LiveName>();
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
      for (const write of applySessionFacts(state, sessionId, envelope.event, conversation)) {
        persistAndInvalidate(write.result, SESSION_RESOURCES, sessionId);
      }

      match(envelope.event)
        .with({ type: "session.ended" }, () => {
          // The session is over — drop its state, folded transcript included.
          // This is the event that exists for exactly that; without it the map
          // only grows, and now each entry costs a conversation.
          sessions.delete(sessionId);
        })
        .with({ type: "turn.ended" }, (ended) => {
          // The agent may have created, updated or pushed a PR during the turn.
          refreshPrSnapshotForSession(sessionId);
          // A cloud turn whose work did not reach the branch: every client is
          // warned, not only the ones following this chat.
          const unsaved = cloudSaveFailure(ended);
          if (unsaved) publish(cloudSaveFailures, {}, unsaved);
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
