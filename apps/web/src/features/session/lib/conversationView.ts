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
 *      tool call, parts. A row's SQL-owned columns (seq, tokens, cost,
 *      cancelled_at) are not part of the question being asked.
 *
 * The `turns` array is synthesized, because the message page has no turn
 * entity: deus's "is the agent working" lives on `sessions.status`, and
 * `agentActivity` needs to know which turn is ACTIVE to answer at all.
 */

import type { ConversationMessage, ConversationState } from "@shared/protocol-types";
import type { Message } from "../types";

/**
 * Project rows into the state the selectors read.
 *
 * `working` marks the last turn active. Without it every turn reads as ended
 * and `agentActivity` can only answer "idle" — the indicator would never move.
 */
export function conversationView(messages: Message[], working: boolean): ConversationState {
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

  const lastTurnId = timeline[timeline.length - 1]?.turnId;
  return {
    timeline,
    turns:
      lastTurnId === undefined
        ? []
        : [
            {
              turnId: lastTurnId,
              status: working ? "active" : "ended",
              errors: [],
              startedAt: 0,
            },
          ],
    permissions: [],
    totals: { input: 0, output: 0 },
    errors: [],
    unknownEvents: [],
    toolInputJson: {},
  };
}
