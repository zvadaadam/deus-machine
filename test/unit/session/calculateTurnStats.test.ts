import { describe, expect, it } from "vitest";
import { calculateTurnStats } from "@/features/session/ui/utils/calculateTurnStats";
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

describe("calculateTurnStats", () => {
  it("counts only completed file-modifying tools toward filesChanged", () => {
    const messages: Message[] = [
      createMessage({
        parts: [
          {
            type: "TOOL",
            id: "tool-1",
            sessionId: "session-1",
            messageId: "message-1",
            partIndex: 0,
            toolCallId: "call-1",
            toolName: "Edit",
            state: {
              status: "COMPLETED",
              input: { file_path: "src/app.ts" },
              time: {
                start: "2026-04-14T09:00:00.000Z",
                end: "2026-04-14T09:00:01.000Z",
              },
            },
          },
          {
            type: "TOOL",
            id: "tool-2",
            sessionId: "session-1",
            messageId: "message-1",
            partIndex: 1,
            toolCallId: "call-2",
            toolName: "Write",
            state: {
              status: "RUNNING",
              input: { file_path: "src/running.ts" },
              time: {
                start: "2026-04-14T09:00:00.000Z",
              },
            },
          },
          {
            type: "TOOL",
            id: "tool-3",
            sessionId: "session-1",
            messageId: "message-1",
            partIndex: 2,
            toolCallId: "call-3",
            toolName: "MultiEdit",
            state: {
              status: "ERROR",
              input: { file_path: "src/error.ts" },
              error: "nope",
              time: {
                start: "2026-04-14T09:00:00.000Z",
                end: "2026-04-14T09:00:01.000Z",
              },
            },
          },
          {
            type: "TOOL",
            id: "tool-4",
            sessionId: "session-1",
            messageId: "message-1",
            partIndex: 3,
            toolCallId: "call-4",
            toolName: "Task",
            state: {
              status: "COMPLETED",
              input: {},
              time: {
                start: "2026-04-14T09:00:00.000Z",
                end: "2026-04-14T09:00:01.000Z",
              },
            },
          },
        ],
      }),
    ];

    expect(calculateTurnStats(messages)).toEqual({
      toolCount: 4,
      subagentCount: 1,
      filesChanged: 1,
    });
  });
});
