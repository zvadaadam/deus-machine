import { findConversationMessage, turnProviderCredentialSource } from "@shared/conversation-rows";
// backend/src/services/agent/event-handler.ts
// The single entry point for agent → backend data flow.
//
// It consumes the @zvada/agent-server lifecycle stream NATIVELY: the envelope
// goes into the engine's own fold, the fold reports what moved, and
// `persistChanges` turns that into rows. There is no translation layer — the
// event that crosses the wire is the event the frontend folds, with the SAME
// reducer, projecting onto the TanStack cache instead of SQLite.
//
// The handler and the verification CLI share the session-column writes in event-facts.ts.
//
// Ordering matters: persist first, then invalidate, then push.

import { match } from "ts-pattern";
import type { SessionEventGap } from "@zvada/agent-server/client";
import type { SessionSnapshotEvent } from "@deus-hq/api";
import {
  projectCloudSnapshot,
  type RestoredCloudConversation,
} from "@shared/cloud-session-snapshot";
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
import { openWith, publish, resetSubscribers } from "../streams";
import {
  persistChanges,
  persistSessionTitle,
  persistSessionStatus,
  type TurnOutcomeWrite,
  type WriteResult,
} from "./persistence";
import { pushCloudSessionTitle } from "./cloud/driver";
import { applySessionFacts, describeEvent, turnOutcomeFor, type SessionFacts } from "./event-facts";
import { refreshPrSnapshotForSession } from "../pr-snapshot.service";
import { restoreCloudSnapshot } from "./cloud/snapshot";
import {
  admitTurn,
  holdingTurn,
  lastTurn,
  releaseTurn,
  reportInterruption,
  forgetChatTurns,
  turnNotices,
  type NativeEnd,
} from "./chat-turn";
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
  /** Mark delivery loss synchronously, before any replay suffix is folded. */
  handleEventGap(gap: SessionEventGap): string | undefined;
  /** Settle only that damaged turn after targeted native reconciliation. */
  settleEventGap(sessionId: string, turnId: string, confirmed: boolean, cause?: "cancelled"): void;
  /** Side-channel title notification (deus/*, not a lifecycle event). */
  handleTitle(sessionId: string, title: string): void;
}

interface SessionState {
  facts: SessionFacts & { forTurn?: string };
  /** The folded conversation — the source of every row this session writes. */
  conversation: ConversationState;
}

/** Only evidence of the new turn retires its predecessor's error and limit reports. */
function reportsFor(state: SessionState, turnId?: string) {
  if (turnId && state.facts.forTurn !== turnId)
    state.facts = { forTurn: turnId, errorReported: false };
  return state.facts;
}

// ---- Resource groups for invalidation ----

const SESSION_RESOURCES: LiveName[] = ["workspaces", "sessions", "session"];
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

  turnNotices.stored = (sessionId, turnId) => {
    const conversation = sessions.get(sessionId)?.conversation;
    // A message anchors the local footer. Reopen streaming parts after the window rereads it.
    if (!conversation?.timeline.some((e) => e.kind === "message" && e.turnId === turnId)) return;
    resetSubscribers(sessionEvents, { sessionId });
    for (const part of typing.of(sessionId, conversation))
      publish(sessionEvents, { sessionId }, part, { keep: false });
  };

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created = { facts: { errorReported: false }, conversation: emptyConversation() };
    sessions.set(sessionId, created);
    return created;
  };

  return {
    hydrateCloudSnapshot(sessionId, snapshot) {
      const state = stateFor(sessionId);
      const turn = holdingTurn(sessionId);
      const current = snapshot.state.currentTurnId;
      const pending =
        turn?.phase === "starting" &&
        current !== turn.turnId &&
        !snapshot.state.turns?.some((t) => t.turnId === turn.turnId);
      const result = restoreCloudSnapshot(sessionId, snapshot, pending);
      if (!result.ok) {
        console.warn(
          `[AgentEvent] Cloud history restore failed: session=${sessionId}`,
          result.error
        );
        return;
      }
      state.conversation = result.value.conversation;
      // A reply being typed when the transcript was restored is open from here on.
      typing.restored(sessionId, projectCloudSnapshot(snapshot).events);
      if (!pending) {
        // A snapshot can stop naming the old turn without carrying its terminal.
        if (turn && turn.turnId !== current)
          releaseTurn(sessionId, turn.turnId, { type: "snapshot" });
        if (current) admitTurn(sessionId, current, "start");
        reportsFor(state, current ?? turn?.turnId).errorReported =
          snapshot.state.status === "error";
      }
      invalidate(SESSION_RESOURCES, { sessionIds: [sessionId] });
      return result.value;
    },

    handleEventGap(gap) {
      const turn = holdingTurn(gap.sessionId);
      // A pending start owns its admission. A gap can settle only a running turn.
      if (turn?.phase !== "running") return;
      const { turnId } = turn;
      const facts = reportsFor(stateFor(gap.sessionId), turnId);
      facts.deliveryFailure ??= {
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

    settleEventGap(sessionId, turnId, confirmed, cause) {
      const facts = sessions.get(sessionId)?.facts;
      if (holdingTurn(sessionId)?.turnId !== turnId || facts?.deliveryFailure?.turnId !== turnId)
        return;
      const message =
        facts.deliveryFailure.message +
        (confirmed ? "" : " The agent has not confirmed it stopped.");
      facts.errorReported = true;
      if (confirmed) {
        releaseTurn(sessionId, turnId, {
          type: cause ?? "gone",
          error: { message, category: "network" },
        });
        return;
      }
      persistAndInvalidate(
        persistSessionStatus(sessionId, "working", message, "network"),
        SESSION_RESOURCES,
        sessionId
      );
      reportInterruption(sessionId, turnId, false, cause);
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

      const stamped = isUnknownEvent(envelope.event) ? envelope.event.raw : envelope.event;
      const turnId = "turnId" in stamped ? stamped.turnId : undefined;
      const messageId = "messageId" in stamped ? stamped.messageId : undefined;
      let holder = holdingTurn(sessionId);
      const last = lastTurn(sessionId);
      // A replay or another cloud client can be the first we hear of this turn; an ended one stays history.
      if (!holder && !isUnknownEvent(envelope.event) && envelope.event.type === "turn.started") {
        if (
          last?.turnId !== turnId &&
          !conversation.turns.some((t) => t.turnId === turnId && t.status === "ended")
        ) {
          admitTurn(sessionId, envelope.event.turnId, "start");
          holder = holdingTurn(sessionId);
        }
      }
      if (
        holder &&
        (turnId === holder.turnId || (turnId === undefined && holder.phase === "running"))
      ) {
        reportsFor(state, holder.turnId);
        const outputAt =
          typeof stamped.timestamp === "number" &&
          envelope.event.type !== "permission.resolved" &&
          envelope.event.type !== "elicitation.resolved" &&
          (typeof messageId !== "string" ||
            findConversationMessage(conversation, messageId)?.role !== "user")
            ? stamped.timestamp
            : undefined;
        admitTurn(sessionId, holder.turnId, "event", outputAt);
      }
      const owner = holder?.turnId ?? last?.turnId;
      const deferred =
        holder && holder.phase !== "running" && last && !last.nativeEnd && last.turnId === turnId;
      const { facts } = state;

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
      let outcome: TurnOutcomeWrite | undefined;
      const writes = isDelta
        ? []
        : persistChanges(
            sessionId,
            conversation,
            changes,
            (turn) => {
              outcome = turnOutcomeFor(facts, deferred ? last.turnId : owner, turn);
              return deferred ? undefined : outcome;
            },
            turnProviderCredentialSource(envelope.event)
          );

      const event = envelope.event;
      let ended: NativeEnd | undefined;
      if (event.type === "turn.ended") {
        const { turnId } = event;
        const cancelled = event.stopReason === "cancelled";
        const held = holder?.turnId === turnId;
        ended = { type: "end", turnId, cancelled, held, outcome };
        if (
          (held || deferred) &&
          outcome?.status === "error" &&
          event.error?.category === "usage_limit" &&
          (!outcome.error || outcome.error.category === "usage_limit")
        ) {
          const resetsAt = Math.max(...(facts.limitResets?.values() ?? []));
          ended.limit = resetsAt > Date.now() ? { resetsAt } : {};
        }
        releaseTurn(sessionId, turnId, ended);
      }
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
      for (const write of applySessionFacts(
        facts,
        envelope.event.type === "turn.started" ? holder?.turnId : owner,
        sessionId,
        envelope.event,
        conversation
      )) {
        persistAndInvalidate(write.result, SESSION_RESOURCES, sessionId);
      }

      match(envelope.event)
        .with({ type: "session.ended" }, () => {
          // The session is over — drop its state, folded transcript included.
          // This is the event that exists for exactly that; without it the map
          // only grows, and now each entry costs a conversation.
          sessions.delete(sessionId);
          forgetChatTurns(sessionId);
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
      if (ended) turnNotices.queue?.(sessionId, ended);
    },
  };
}
