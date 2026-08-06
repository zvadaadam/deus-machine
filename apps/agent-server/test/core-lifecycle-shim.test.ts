// Phase A shim: exact LifecycleEvent → deus PartEvent sequences.
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "@agent-server/protocol";
import { LifecycleToPartEvents, toDeusPart } from "../agents/core/lifecycle-shim";

const T = 1;

function textPart(id: string, text: string, state: "streaming" | "done") {
  return { id, sessionId: "s", messageId: "m1", type: "text" as const, text, state };
}

describe("LifecycleToPartEvents", () => {
  it("translates a streamed text turn into the legacy sequence exactly", () => {
    const shim = new LifecycleToPartEvents();
    const events: LifecycleEvent[] = [
      { type: "turn.started", turnId: "t1", sessionId: "s", timestamp: T },
      {
        type: "message.started",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "message.part",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        partIndex: 0,
        part: textPart("p1", "", "streaming"),
        timestamp: T,
      },
      {
        type: "message.part.delta",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        partIndex: 0,
        partId: "p1",
        delta: { type: "text-delta", text: "hello" },
        timestamp: T,
      },
      {
        type: "message.part",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        partIndex: 0,
        part: textPart("p1", "hello", "done"),
        timestamp: T,
      },
      { type: "message.ended", turnId: "t1", messageId: "m1", timestamp: T },
      {
        type: "turn.ended",
        turnId: "t1",
        sessionId: "s",
        stopReason: "end_turn",
        finishReason: "end_turn",
        tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
        cost: 0.01,
        timestamp: T,
      },
    ];
    const out = events.flatMap((e) => shim.translate(e));
    expect(out.map((e) => e.type)).toEqual([
      "turn.started",
      "message.created",
      "part.created",
      "part.delta",
      "part.done",
      "message.done",
      "turn.completed",
    ]);
    const partDone = out.find((e) => e.type === "part.done");
    expect(partDone && "part" in partDone && partDone.part).toMatchObject({
      type: "TEXT",
      text: "hello",
      state: "DONE",
    });
    const messageDone = out.find((e) => e.type === "message.done");
    expect(messageDone && "parts" in messageDone && messageDone.parts).toHaveLength(1);
    const completed = out.find((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ turnId: "t1", cost: 0.01 });
  });

  it("emits the created→done pair for parts terminal on first sight", () => {
    // Completed-on-arrival messages (Codex SDK) surface as one message.part
    // snapshot already in state done — consumers keying finality off part.done
    // must still see it.
    const shim = new LifecycleToPartEvents();
    const out = shim.translate({
      type: "message.part",
      turnId: "t1",
      messageId: "m1",
      outputIndex: 0,
      partIndex: 0,
      part: textPart("p1", "DEUS-CORE-OK", "done"),
      timestamp: T,
    });
    expect(out.map((e) => e.type)).toEqual(["part.created", "part.done"]);
    expect(out[1] && "part" in out[1] && out[1].part).toMatchObject({
      type: "TEXT",
      text: "DEUS-CORE-OK",
      state: "DONE",
    });
  });

  it("maps engine stop reasons onto deus finish reasons", () => {
    const shim = new LifecycleToPartEvents();
    const out = shim.translate({
      type: "turn.ended",
      turnId: "t1",
      sessionId: "s",
      stopReason: "max_turn_requests",
      timestamp: T,
    });
    expect(out[0]).toMatchObject({ type: "turn.completed", finishReason: "max_turns" });
  });

  it("maps tool parts through PENDING/RUNNING/COMPLETED vocabulary", () => {
    const running = toDeusPart({
      id: "p2",
      sessionId: "s",
      messageId: "m1",
      type: "tool",
      toolCallId: "tc1",
      toolName: "Bash",
      kind: "execute",
      state: { status: "in_progress", input: { command: "ls" }, time: { start: 1 } },
    });
    expect(running).toMatchObject({
      type: "TOOL",
      toolName: "Bash",
      state: { status: "RUNNING", input: { command: "ls" } },
    });
    const failed = toDeusPart({
      id: "p2",
      sessionId: "s",
      messageId: "m1",
      type: "tool",
      toolCallId: "tc1",
      toolName: "Bash",
      state: {
        status: "failed",
        input: { command: "ls" },
        error: "boom",
        time: { start: 1, end: 2 },
      },
    });
    expect(failed.type === "TOOL" && failed.state).toMatchObject({
      status: "ERROR",
      error: "boom",
    });
  });
});
