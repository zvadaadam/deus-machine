/**
 * The other two writers of the message cache: the q:delta merge and the
 * composer's own rollback.
 *
 * Both used to key on an id prefix — "any row called optimistic-* dies on the
 * next delta" — which made a REJECTED send silently disappear: the backend
 * writes no user row (the engine echo does), so the typed message existed only
 * in this cache. Retirement is keyed on the send's `turn_id` now, and a
 * rejection removes exactly its own bubble.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { mergeMessageDelta } from "../../../apps/web/src/features/session/lib/messageCache";
import {
  createOptimisticUserMessage,
  dropOptimisticMessage,
} from "../../../apps/web/src/features/session/lib/optimisticMessage";
import { messagesKey } from "../../../apps/web/src/features/session/lib/agentEventFold";
import type { PaginatedMessages } from "../../../apps/web/src/features/session/api/session.service";
import type { Message } from "../../../shared/types/session";

const SESSION = "sess-1";
const TURN = "turn-1";

function page(messages: Message[]): PaginatedMessages {
  return { messages, compactions: [], has_older: false, has_newer: false };
}

function bubble(turnId = TURN, content = "hello") {
  return createOptimisticUserMessage({ sessionId: SESSION, turnId, content });
}

function echo(turnId = TURN, id = "u-engine"): Message {
  return {
    id,
    session_id: SESSION,
    seq: 7,
    role: "user",
    content: null,
    turn_id: turnId,
  };
}

describe("mergeMessageDelta", () => {
  it("retires the bubble whose echo just arrived", () => {
    const merged = mergeMessageDelta(page([bubble()]), [echo()]) as PaginatedMessages;

    expect(merged.messages.map((m) => m.id)).toEqual(["u-engine"]);
  });

  it("leaves an unrelated turn's bubble alone — a rejected send must not vanish", () => {
    const rejected = bubble("turn-rejected", "never sent");
    const merged = mergeMessageDelta(page([rejected]), [
      { ...echo(), id: "a1", role: "assistant", turn_id: "turn-other" },
    ]) as PaginatedMessages;

    expect(merged.messages.map((m) => m.id)).toEqual([rejected.id, "a1"]);
  });

  it("deduplicates by id", () => {
    const existing = echo(TURN, "u-engine");
    const merged = mergeMessageDelta(page([existing]), [existing]) as PaginatedMessages;

    expect(merged.messages).toHaveLength(1);
  });

  it("keeps compaction markers — a message delta must never drop a divider", () => {
    const withMarkers: PaginatedMessages = {
      ...page([]),
      compactions: [
        {
          compaction_id: "c1",
          session_id: SESSION,
          turn_id: TURN,
          status: "completed",
          created_at: "2026-08-15T10:00:00.000Z",
        },
      ],
    };
    const merged = mergeMessageDelta(withMarkers, [echo()]) as PaginatedMessages;

    expect(merged.compactions).toHaveLength(1);
  });

  it("returns the cache untouched when there is nothing to merge", () => {
    const original = page([bubble()]);
    expect(mergeMessageDelta(original, [])).toBe(original);
    expect(mergeMessageDelta(undefined, [echo()])).toBeUndefined();
  });
});

describe("dropOptimisticMessage (the rejection path)", () => {
  it("removes exactly the rejected send's bubble", () => {
    const qc = new QueryClient();
    const mine = bubble(TURN, "rejected");
    const theirs = bubble("turn-2", "in flight");
    qc.setQueryData(messagesKey(SESSION), page([echo("turn-0", "old"), mine, theirs]));

    dropOptimisticMessage(qc, SESSION, TURN);

    expect(
      qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!.messages.map((m) => m.id)
    ).toEqual(["old", theirs.id]);
  });

  it("is a no-op when there is no page and when the bubble is already gone", () => {
    const qc = new QueryClient();
    dropOptimisticMessage(qc, SESSION, TURN);
    expect(qc.getQueryData(messagesKey(SESSION))).toBeUndefined();

    const settled = page([echo()]);
    qc.setQueryData(messagesKey(SESSION), settled);
    dropOptimisticMessage(qc, SESSION, TURN);
    expect(qc.getQueryData(messagesKey(SESSION))).toBe(settled);
  });
});
