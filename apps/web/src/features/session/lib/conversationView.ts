/**
 * The cached SQLite rows, read back as the engine's `ConversationState`.
 *
 * The renderer's source of truth is a paginated `Message[]` — that is what the
 * DB snapshot, the load-older page and the WS delta all speak. The engine's
 * read-only projections (`groupIntoTurns`, `subagentGroups`, `agentActivity`)
 * take a `ConversationState`. This is the one adapter between them, so the
 * three derivations they replace exist once, upstream, instead of three times
 * in three components.
 *
 * Two properties make the adapter safe rather than lossy:
 *
 *   1. It is INPUT-only. Nothing here flows back into the cache — the selectors
 *      return positions and verdicts, and the caller reads its own rows at
 *      those positions (`groupIntoTurns` preserves order, so a group is a
 *      contiguous SLICE of the array that was passed in).
 *   2. It projects only the fields the selectors read: id, turn, role, parent
 *      tool call, parts. Per-turn accounting is rendered separately from
 *      the turn records and does not affect message grouping.
 */

import type { ConversationMessage, ConversationState } from "@shared/protocol-types";
import type { Message, SessionTurn } from "../types";

function isUnfinished(turn: SessionTurn): boolean {
  return turn.endedAt === undefined && !turn.stopReason;
}

export function openConversationTurn(
  newestTurnId: string | null | undefined,
  working: boolean,
  records: readonly SessionTurn[] = []
): ConversationState["turns"][number] | undefined {
  // An unfinished last record wins. A replay can append an older end, so otherwise use the
  // newest message's record, or the chat's working status until that record arrives.
  const last = records.at(-1);
  const record =
    last && isUnfinished(last) ? last : records.find((turn) => turn.turnId === newestTurnId);
  const turnId = record?.turnId ?? newestTurnId;
  const open = record ? isUnfinished(record) : working;
  if (!turnId || !open) return undefined;
  return { turnId, startedAt: record?.startedAt ?? 0, status: "active", errors: [] };
}

export function conversationView(
  messages: Message[],
  working: boolean,
  records: readonly SessionTurn[] = [],
  newestTurnId = messages.at(-1)?.turn_id
): ConversationState {
  const timeline: ConversationMessage[] = messages.map((message) => ({
    kind: "message",
    messageId: message.id,
    sessionId: message.session_id,
    turnId: message.turn_id ?? "",
    outputIndex: 0,
    role: message.role === "user" ? "user" : "assistant",
    ...(message.parent_tool_call_id ? { parentToolCallId: message.parent_tool_call_id } : {}),
    ...(message.model ? { model: message.model } : {}),
    parts: message.parts ?? [],
    startedAt: message.sent_at ? Date.parse(message.sent_at) : 0,
  }));

  const open = openConversationTurn(newestTurnId, working, records);
  return {
    timeline,
    turns: open ? [open] : [],
    permissions: [],
    elicitations: [],
    totals: { input: 0, output: 0 },
    errors: [],
    unknownEvents: [],
    toolInputJson: {},
  };
}
