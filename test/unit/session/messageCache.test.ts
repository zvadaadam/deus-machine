import { describe, expect, it } from "vitest";

import { mergeMessageDelta } from "@/features/session/lib/messageCache";
import type { PaginatedMessages } from "@/features/session/api/session.service";

describe("mergeMessageDelta", () => {
  it("upserts message shells with persisted message metadata without losing streamed parts", () => {
    const old: PaginatedMessages = {
      messages: [
        {
          id: "assistant-1",
          session_id: "session-1",
          seq: 2,
          messageIndex: 1,
          role: "assistant",
          content: "",
          sent_at: "2026-05-13T12:00:00.000Z",
          parts: [
            {
              type: "TEXT",
              id: "part-1",
              sessionId: "session-1",
              messageId: "assistant-1",
              partIndex: 0,
              text: "Hello",
              state: "STREAMING",
            },
          ],
        },
      ],
      has_older: false,
      has_newer: false,
    };

    const merged = mergeMessageDelta(old, [
      {
        id: "assistant-1",
        session_id: "session-1",
        seq: 2,
        messageIndex: 1,
        role: "assistant",
        content: "",
        sent_at: "2026-05-13T12:00:01.000Z",
        stop_reason: null,
        parts: [],
      },
    ]) as PaginatedMessages;

    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]?.seq).toBe(2);
    expect(merged.messages[0]?.messageIndex).toBe(1);
    expect(merged.messages[0]?.parts?.[0]).toMatchObject({
      id: "part-1",
      text: "Hello",
    });
  });

  it("sorts incoming messages by messageIndex", () => {
    const old: PaginatedMessages = { messages: [], has_older: false, has_newer: false };

    const merged = mergeMessageDelta(old, [
      {
        id: "assistant-1",
        session_id: "session-1",
        seq: 2,
        messageIndex: 1,
        role: "assistant",
        content: "",
      },
      {
        id: "user-1",
        session_id: "session-1",
        seq: 1,
        messageIndex: 0,
        role: "user",
        content: "[]",
      },
    ]) as PaginatedMessages;

    expect(merged.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
  });
});
