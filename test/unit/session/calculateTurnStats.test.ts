import { describe, expect, it } from "vitest";
import { calculateTurnStats } from "@/features/session/ui/utils/calculateTurnStats";
import type { Part } from "@shared/protocol-types";

describe("calculateTurnStats", () => {
  it("counts each file in a completed Codex patch once, including deletions", () => {
    const patch = {
      type: "tool" as const,
      id: "patch",
      toolCallId: "call-1",
      sessionId: "session-1",
      messageId: "message-1",
      toolName: "apply_patch",
      partIndex: 0,
    };
    const time = { start: 1, end: 2 };
    const parts: Part[] = [
      {
        ...patch,
        state: {
          status: "completed",
          input: {},
          output: "",
          time,
          content: [
            { type: "diff", path: "a.ts", oldText: "a", newText: "b" },
            { type: "diff", path: "a.ts", oldText: "c", newText: "d" },
            { type: "diff", path: "deleted.ts", oldText: "old\n", newText: "" },
          ],
        },
      },
      {
        ...patch,
        id: "failed-patch",
        toolCallId: "call-2",
        state: { status: "failed", input: { file_path: "other.ts" }, error: "failed", time },
      },
    ];
    expect(calculateTurnStats(parts)).toEqual({
      filesChanged: 2,
      toolCount: 2,
      subagentCount: 0,
    });
  });

  it("counts only completed file-modifying tools toward filesChanged", () => {
    const parts: Part[] = [
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
    ];

    expect(calculateTurnStats(parts)).toEqual({
      toolCount: 4,
      subagentCount: 1,
      filesChanged: 1,
    });
  });
});
