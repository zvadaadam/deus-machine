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
    turn_stop_reason: overrides.turn_stop_reason ?? null,
    ...overrides,
  };
}

describe("calculateTurnStats", () => {
  it("counts only completed file-modifying tools toward filesChanged", () => {
    const messages: Message[] = [
      createMessage({
        parts: [
          {
            type: "tool",
            id: "tool-1",
            sessionId: "session-1",
            messageId: "message-1",
            toolCallId: "call-1",
            toolName: "Edit",
            state: {
              status: "completed",
              input: { file_path: "src/app.ts" },
              time: {
                start: 1776157200000,
                end: 1776157201000,
              },
            },
          },
          {
            type: "tool",
            id: "tool-2",
            sessionId: "session-1",
            messageId: "message-1",
            toolCallId: "call-2",
            toolName: "Write",
            state: {
              status: "in_progress",
              input: { file_path: "src/running.ts" },
              time: {
                start: 1776157200000,
              },
            },
          },
          {
            type: "tool",
            id: "tool-3",
            sessionId: "session-1",
            messageId: "message-1",
            toolCallId: "call-3",
            toolName: "MultiEdit",
            state: {
              status: "failed",
              input: { file_path: "src/error.ts" },
              error: "nope",
              time: {
                start: 1776157200000,
                end: 1776157201000,
              },
            },
          },
          {
            type: "tool",
            id: "tool-4",
            sessionId: "session-1",
            messageId: "message-1",
            toolCallId: "call-4",
            toolName: "Task",
            kind: "task",
            state: {
              status: "completed",
              input: {},
              time: {
                start: 1776157200000,
                end: 1776157201000,
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
