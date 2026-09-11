// A cloud snapshot projected into the canonical conversation events.
// Both desktop persistence and the direct browser consume this projection;
// callers own status, ordering and live side effects.

import type { SessionSnapshotEvent, TurnProviderCredentialSource } from "@deus-hq/api";
import type { AnyLifecycleEvent, ConversationState } from "./protocol-types";

/** Backend fold restored from cloud history, at its new stream position. */
export interface AgentConversationSnapshot {
  sessionId: string;
  seq: number;
  conversation: ConversationState;
  providerCredentialSources?: Record<string, TurnProviderCredentialSource>;
  /** SQLite's complete message order, including local-only rows. */
  messageIds: string[];
}

export type RestoredCloudConversation = Pick<
  AgentConversationSnapshot,
  "conversation" | "messageIds" | "providerCredentialSources"
>;

type SnapshotMessage = NonNullable<SessionSnapshotEvent["messages"]>[number];
type SnapshotPart = SnapshotMessage["parts"][number];
type SnapshotTurn = NonNullable<SessionSnapshotEvent["state"]["turns"]>[number];
type SnapshotCompaction = NonNullable<SessionSnapshotEvent["state"]["compactions"]>[number];

export function projectCloudSnapshot(snapshot: SessionSnapshotEvent): {
  events: AnyLifecycleEvent[];
  messageIds: string[];
} {
  const events: AnyLifecycleEvent[] = [];
  const route = (event: AnyLifecycleEvent) => {
    events.push(event);
  };
  const messages = snapshot.messages ?? [];
  const currentTurnId = snapshot.state.currentTurnId ?? null;

  // A snapshot does NOT restate the live turn's `turn.started` (its
  // `state.turns` carries only ENDED turns' accounting, and `message.started`
  // never opens a turn in the reducer) — so a mid-turn (re)connect would leave
  // `state.turns` without an active entry, and the one-live-turn send guard
  // would wave an overlapping prompt through (agnt QUEUES it; deus's contract
  // is one live turn). Synthesize the start before the transcript; the reducer
  // no-ops on replay overlap. The stamp is connect-time — the true start rode
  // an event this client never saw, and nothing reads an active turn's clock.
  for (const turn of snapshot.state.turns ?? []) {
    if (turn.startedAt !== undefined)
      route({
        type: "turn.started",
        sessionId: "",
        turnId: turn.turnId,
        timestamp: turn.startedAt,
        ...(turn.execution && { execution: turn.execution }),
      });
  }
  if (currentTurnId) {
    route({
      type: "turn.started",
      sessionId: null,
      turnId: currentTurnId,
      timestamp: Date.now(),
    } as unknown as AnyLifecycleEvent);
  }

  // `messageIndex` is the session-scoped ordinal; folding in that order lands
  // the reconstructed rows in transcript order.
  const ordered = [...messages].sort((a, b) => a.messageIndex - b.messageIndex);
  for (const message of ordered) {
    route(messageStartedEvent(message));
    message.parts.forEach((part, partIndex) => route(messagePartEvent(message, part, partIndex)));
  }

  // The live turn's accounting arrives on the live stream as its own
  // `turn.ended`; only the already-ended turns need restating from the snapshot.
  for (const turn of snapshot.state.turns ?? []) {
    if (turn.turnId === currentTurnId) continue;
    route(turnEndedEvent(turn));
  }

  // Historical compaction dividers ride the snapshot's `state.compactions`, NOT
  // its messages — unroll each back through the same reducer path the live
  // stream uses (`session.compaction` → `compaction-upserted` → the page's
  // `compactions` list), or a direct session's transcript loses every "context
  // compacted" marker on reconnect.
  for (const compaction of snapshot.state.compactions ?? []) {
    route(compactionEvent(compaction));
  }

  const usageTurnId = currentTurnId ?? snapshot.state.turns?.at(-1)?.turnId;
  if (snapshot.state.contextUsed != null && usageTurnId) {
    route({
      type: "session.usage",
      sessionId: "",
      turnId: usageTurnId,
      used: snapshot.state.contextUsed,
      ...(snapshot.state.contextSize != null ? { size: snapshot.state.contextSize } : {}),
      timestamp: Date.now(),
    });
  }

  return { events, messageIds: ordered.map((message) => message.id) };
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
    ...(turn.execution !== undefined ? { execution: turn.execution } : {}),
    ...(turn.providerCredentialSource !== undefined
      ? { providerCredentialSource: turn.providerCredentialSource }
      : {}),
    ...(turn.tokens !== undefined ? { tokens: turn.tokens } : {}),
    ...(turn.cost !== undefined ? { cost: turn.cost } : {}),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  } as unknown as AnyLifecycleEvent;
}

/**
 * A snapshot's `state.compactions` entry → the `session.compaction` event that
 * produced it. The entry carries every field the event does except `sessionId`,
 * which `route` stamps on the way through — so the reducer folds it into the
 * timeline exactly as the live event would, and the fold's `compaction-upserted`
 * projection lands the divider in the page.
 */
function compactionEvent(compaction: SnapshotCompaction): AnyLifecycleEvent {
  return {
    type: "session.compaction",
    ...compaction,
  } as unknown as AnyLifecycleEvent;
}
