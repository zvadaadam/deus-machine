import { describe, expect, it } from "vitest";
import { getTurnFooterData } from "@/features/session/ui/utils/getTurnFooterData";
import type { Message } from "@/shared/types";

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? "message-1",
    session_id: "session-1",
    seq: overrides.seq ?? 1,
    role: overrides.role ?? "assistant",
    content: overrides.content ?? "",
    parts: overrides.parts,
    sent_at: overrides.sent_at ?? null,
    cancelled_at: overrides.cancelled_at ?? null,
    stop_reason: overrides.stop_reason ?? null,
    ...overrides,
  };
}

describe("getTurnFooterData", () => {
  it("copies the latest text-bearing assistant message and uses the latest part end time", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-1",
        sent_at: "2026-04-13T10:00:03.000Z",
        parts: [
          {
            type: "TEXT",
            id: "part-1",
            sessionId: "session-1",
            messageId: "message-1",
            partIndex: 0,
            text: "Done.",
            state: "DONE",
          },
        ],
      }),
      createMessage({
        id: "message-2",
        sent_at: "2026-04-13T10:00:05.000Z",
        parts: [
          {
            type: "TOOL",
            id: "part-2",
            sessionId: "session-1",
            messageId: "message-2",
            partIndex: 0,
            toolCallId: "tool-1",
            toolName: "Read",
            state: {
              status: "COMPLETED",
              input: { file_path: "src/app.ts" },
              time: {
                start: "2026-04-13T10:00:04.000Z",
                end: "2026-04-13T10:00:09.000Z",
              },
            },
          },
        ],
      }),
    ];

    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z")).toEqual({
      copyText: "Done.",
      durationMs: 9000,
    });
  });

  it("falls back to the last assistant sent_at when no part timings are available", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-3",
        sent_at: "2026-04-13T10:00:06.000Z",
        parts: [
          {
            type: "TEXT",
            id: "part-3",
            sessionId: "session-1",
            messageId: "message-3",
            partIndex: 0,
            text: "Short answer",
            state: "DONE",
          },
        ],
      }),
    ];

    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z")).toEqual({
      copyText: "Short answer",
      durationMs: 6000,
    });
  });

  it("uses cancelled_at for interrupted turns and omits invalid durations", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-4",
        parts: [
          {
            type: "TEXT",
            id: "part-4",
            sessionId: "session-1",
            messageId: "message-4",
            partIndex: 0,
            text: "Partial response",
            state: "DONE",
          },
        ],
        cancelled_at: "2026-04-13T10:00:08.000Z",
      }),
    ];

    expect(getTurnFooterData(messages, "not-a-date")).toEqual({
      copyText: "Partial response",
      durationMs: null,
    });
    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z")).toEqual({
      copyText: "Partial response",
      durationMs: 8000,
    });
  });
});
