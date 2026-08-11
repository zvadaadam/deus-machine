// The engine→deus shim gate: every payload the broadcaster would emit must
// satisfy deus's zod schemas — the backend validates with
// AgentEventSchema.safeParse and silently SKIPS invalid events, so a subset
// match (toMatchObject) is not enough here. Each test wraps the shim output
// exactly the way EventBroadcaster.emitPartEvent does and parses it.
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "@agent-server/protocol";
import { AgentEventSchema, type PartEvent } from "@shared/agent-events";
import { LifecycleToPartEvents, toDeusPart, toDeusTokens } from "../agents/core/lifecycle-shim";

const T = 1_700_000_000_000;

/** Mirror EventBroadcaster.emitPartEvent's payload construction. */
function wrap(partEvent: PartEvent, messageId = "m1") {
  const base = { sessionId: "s", agentHarness: "claude" as const };
  switch (partEvent.type) {
    case "turn.started":
      return { type: "turn.started", ...base, messageId, turnId: partEvent.turnId };
    case "message.created":
      return {
        type: "message.created",
        ...base,
        messageId: partEvent.messageId,
        role: partEvent.role,
        ...(partEvent.parentToolCallId ? { parentToolCallId: partEvent.parentToolCallId } : {}),
      };
    case "part.created":
    case "part.done":
      return {
        type: partEvent.type,
        ...base,
        messageId: partEvent.part.messageId,
        partId: partEvent.part.id,
        part: partEvent.part,
      };
    case "part.delta":
      return { type: "part.delta", ...base, partId: partEvent.partId, delta: partEvent.delta };
    case "message.done":
      return {
        type: "message.done",
        ...base,
        messageId: partEvent.messageId,
        parts: partEvent.parts,
        ...(partEvent.parentToolCallId ? { parentToolCallId: partEvent.parentToolCallId } : {}),
      };
    case "turn.completed":
      return {
        type: "turn.completed",
        ...base,
        messageId,
        turnId: partEvent.turnId,
        ...(partEvent.finishReason ? { finishReason: partEvent.finishReason } : {}),
        ...(partEvent.tokens ? { tokens: partEvent.tokens } : {}),
        ...(partEvent.cost != null ? { cost: partEvent.cost } : {}),
      };
    default:
      throw new Error(`unmapped part event: ${(partEvent as { type: string }).type}`);
  }
}

/** Translate + schema-validate every emission (the backend's acceptance bar). */
function translateValidated(shim: LifecycleToPartEvents, event: LifecycleEvent): PartEvent[] {
  const out = shim.translate(event);
  for (const partEvent of out) AgentEventSchema.parse(wrap(partEvent));
  return out;
}

function textPart(id: string, text: string, state: "streaming" | "done") {
  return { id, sessionId: "s", messageId: "m1", type: "text" as const, text, state };
}

const toolPart = (
  state:
    | { status: "pending"; partialInput: string }
    | { status: "in_progress"; input: Record<string, unknown>; time: { start: number } }
    | {
        status: "completed";
        input: Record<string, unknown>;
        output: string;
        title: string;
        time: { start: number; end: number };
      }
    | {
        status: "failed";
        input: Record<string, unknown>;
        error: string;
        time: { start: number; end: number };
      }
) => ({
  id: "tp1",
  sessionId: "s",
  messageId: "m1",
  type: "tool" as const,
  toolCallId: "tc1",
  toolName: "Bash",
  kind: "execute" as const,
  state,
});

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
        tokens: { input: 10, output: 5, cache: { read: 7, write: 3 } },
        cost: 0.01,
        timestamp: T,
      },
    ];
    const out = events.flatMap((e) => translateValidated(shim, e));
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
      partIndex: 0,
    });
    const completed = out.find((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({
      turnId: "t1",
      cost: 0.01,
      tokens: { input: 10, output: 5, cacheRead: 7, cacheCreation: { total: 3 } },
    });
  });

  it("translates a tool lifecycle into schema-valid deus tool states", () => {
    const shim = new LifecycleToPartEvents();
    const at = (part: ReturnType<typeof toolPart>, partIndex = 1): LifecycleEvent => ({
      type: "message.part",
      turnId: "t1",
      messageId: "m1",
      outputIndex: 0,
      partIndex,
      part,
      timestamp: T,
    });

    const created = translateValidated(
      shim,
      at(toolPart({ status: "pending", partialInput: "{" }))
    );
    expect(created.map((e) => e.type)).toEqual(["part.created"]);
    expect((created[0] as { part: { state: unknown } }).part.state).toEqual({
      status: "PENDING",
      partialInput: "{",
    });

    // pending → running re-emits part.created: the RUNNING state carries the
    // first parsed tool input, and the frontend upserts parts by id.
    const running = translateValidated(
      shim,
      at(toolPart({ status: "in_progress", input: { command: "ls" }, time: { start: T } }))
    );
    expect(running.map((e) => e.type)).toEqual(["part.created"]);
    expect((running[0] as { part: { state: { status: string } } }).part.state.status).toBe(
      "RUNNING"
    );

    // Same state again (input refinement only) — no re-emission.
    const runningAgain = translateValidated(
      shim,
      at(toolPart({ status: "in_progress", input: { command: "ls -la" }, time: { start: T } }))
    );
    expect(runningAgain).toEqual([]);

    const done = translateValidated(
      shim,
      at(
        toolPart({
          status: "completed",
          input: { command: "ls" },
          output: "file.txt",
          title: "ls",
          time: { start: T, end: T + 500 },
        })
      )
    );
    expect(done.map((e) => e.type)).toEqual(["part.done"]);
    expect((done[0] as { part: { state: unknown; kind?: string } }).part).toMatchObject({
      kind: "bash",
      state: {
        status: "COMPLETED",
        output: "file.txt",
        time: { start: new Date(T).toISOString(), end: new Date(T + 500).toISOString() },
      },
    });

    const ended = translateValidated(shim, {
      type: "message.ended",
      turnId: "t1",
      messageId: "m1",
      timestamp: T,
    });
    expect((ended[0] as { parts: unknown[] }).parts).toHaveLength(1);
  });

  it("emits the created→done pair for a tool terminal on first sight", () => {
    const shim = new LifecycleToPartEvents();
    const out = translateValidated(shim, {
      type: "message.part",
      turnId: "t1",
      messageId: "m1",
      outputIndex: 0,
      partIndex: 0,
      part: toolPart({
        status: "failed",
        input: {},
        error: "boom",
        time: { start: T, end: T + 1 },
      }),
      timestamp: T,
    });
    expect(out.map((e) => e.type)).toEqual(["part.created", "part.done"]);
    expect((out[1] as { part: { state: unknown } }).part.state).toMatchObject({
      status: "ERROR",
      error: "boom",
    });
  });

  it("carries the sub-agent parent onto message.created and message.done", () => {
    const shim = new LifecycleToPartEvents();
    const created = translateValidated(shim, {
      type: "message.started",
      turnId: "t1",
      messageId: "m-sub",
      outputIndex: 1,
      role: "assistant",
      parentToolUseId: "task-1",
      timestamp: T,
    });
    expect(created[0]).toMatchObject({ type: "message.created", parentToolCallId: "task-1" });
    const done = translateValidated(shim, {
      type: "message.ended",
      turnId: "t1",
      messageId: "m-sub",
      timestamp: T,
    });
    expect(done[0]).toMatchObject({ type: "message.done", parentToolCallId: "task-1" });
  });

  it("maps engine stop reasons onto deus finish reasons", () => {
    const shim = new LifecycleToPartEvents();
    const out = translateValidated(shim, {
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
      state: { status: "in_progress", input: { command: "ls" }, time: { start: T } },
    });
    expect(running).toMatchObject({
      type: "TOOL",
      toolName: "Bash",
      state: {
        status: "RUNNING",
        input: { command: "ls" },
        time: { start: new Date(T).toISOString() },
      },
    });
    expect(
      toDeusTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })
    ).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheCreation: { total: 5 } });
  });

  it("maps sub-agent spawning tools to kind 'task' regardless of engine kind", () => {
    // deus renders nested child output only under kind "task" — the engine
    // classifies Task under ACP's taxonomy as "other", which would flatten it.
    const task = toDeusPart({
      id: "p1",
      sessionId: "s",
      messageId: "m1",
      type: "tool",
      toolCallId: "tc1",
      toolName: "Task",
      kind: "other",
      state: { status: "in_progress", input: { prompt: "explore" }, time: { start: T } },
    });
    expect(task).toMatchObject({ type: "TOOL", kind: "task" });
  });
});
