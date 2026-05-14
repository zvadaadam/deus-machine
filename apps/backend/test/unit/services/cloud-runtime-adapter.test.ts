import { describe, expect, it } from "vitest";

import { createCloudRuntimeAdapter } from "../../../src/services/cloud-runtime-adapter";

const sessionId = "session-1";
const turnId = "turn-1";
const messageId = "message-1";
const createdAt = "2026-05-13T12:00:00.000Z";

function createAdapter() {
  return createCloudRuntimeAdapter({ sessionId, agentHarness: "claude" });
}

describe("cloud-runtime-adapter", () => {
  it("projects assistant message snapshots into Deus Machine message and part events", () => {
    const adapter = createAdapter();

    expect(
      adapter.handle({
        type: "message.updated",
        sessionId,
        messageId: "user-1",
        message: {
          id: "user-1",
          sessionId,
          turnId,
          messageIndex: 0,
          role: "USER",
          createdAt,
        },
      } as any)
    ).toEqual([]);

    expect(
      adapter.handle({
        type: "turn.started",
        sessionId,
        turnId,
        messageId,
      } as any)
    ).toEqual([]);

    expect(
      adapter.handle({
        type: "message.updated",
        sessionId,
        messageId,
        message: {
          id: messageId,
          sessionId,
          turnId,
          messageIndex: 1,
          role: "ASSISTANT",
          createdAt,
        },
      } as any)
    ).toMatchObject([{ type: "message.created", messageId, role: "assistant", messageIndex: 1 }]);

    expect(
      adapter.handle({
        type: "message.part.updated",
        sessionId,
        messageId,
        part: {
          type: "TEXT",
          id: "part-1",
          sessionId,
          messageId,
          partIndex: 0,
          text: "Hello",
          state: "STREAMING",
        },
      } as any)
    ).toMatchObject([
      {
        type: "part.created",
        partId: "part-1",
        part: { type: "TEXT", text: "Hello", state: "STREAMING" },
      },
    ]);

    const finalEvents = adapter.handle({
      type: "message.ended",
      sessionId,
      messageId,
      finishReason: "end_turn",
      message: {
        id: messageId,
        sessionId,
        turnId,
        messageIndex: 1,
        role: "ASSISTANT",
        createdAt,
        completedAt: "2026-05-13T12:00:01.000Z",
        parts: [
          {
            type: "TEXT",
            id: "part-1",
            sessionId,
            messageId,
            partIndex: 0,
            text: "Hello world",
            state: "DONE",
          },
        ],
      },
    } as any);

    expect(finalEvents.map((event) => event.type)).toEqual([
      "part.created",
      "part.done",
      "message.done",
    ]);
    expect(finalEvents.at(-1)).toMatchObject({
      type: "message.done",
      messageId,
      stopReason: "end_turn",
      parts: [{ type: "TEXT", text: "Hello world", state: "DONE" }],
    });
  });

  it("maps runtime tool states", () => {
    const adapter = createAdapter();
    adapter.handle({
      type: "message.updated",
      sessionId,
      messageId,
      message: {
        id: messageId,
        sessionId,
        turnId,
        messageIndex: 0,
        role: "ASSISTANT",
        createdAt,
      },
    } as any);

    const runningEvents = adapter.handle({
      type: "message.part.updated",
      sessionId,
      messageId,
      part: {
        type: "TOOL",
        id: "tool-part-1",
        sessionId,
        messageId,
        partIndex: 0,
        toolCallId: "tool-call-1",
        toolName: "Bash",
        state: {
          status: "RUNNING",
          input: { command: "echo ok" },
          time: { start: createdAt },
        },
      },
    } as any);

    expect(runningEvents).toMatchObject([
      {
        type: "part.created",
        part: {
          type: "TOOL",
          kind: "bash",
          state: { status: "RUNNING", input: { command: "echo ok" } },
        },
      },
    ]);

    const completedEvents = adapter.handle({
      type: "message.part.updated",
      sessionId,
      messageId,
      part: {
        type: "TOOL",
        id: "tool-part-1",
        sessionId,
        messageId,
        partIndex: 0,
        toolCallId: "tool-call-1",
        toolName: "Bash",
        state: {
          status: "COMPLETED",
          input: { command: "echo ok" },
          output: "ok",
          time: { start: createdAt, end: "2026-05-13T12:00:01.000Z" },
        },
      },
    } as any);

    expect(completedEvents.map((event) => event.type)).toEqual(["part.created", "part.done"]);
    expect(completedEvents.at(-1)).toMatchObject({
      type: "part.done",
      part: {
        type: "TOOL",
        state: {
          status: "COMPLETED",
          content: [{ type: "text", text: "ok" }],
        },
      },
    });
  });
});
