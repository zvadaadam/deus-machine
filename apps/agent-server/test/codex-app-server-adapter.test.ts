import { describe, expect, it } from "vitest";
import { codexAppServerAdapter } from "../messages/codex-app-server-adapter";
import type { StreamContext, PartEvent } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1", turnId: "turn-1" };
}

function partFrom(evt: PartEvent) {
  if (evt.type === "part.created" || evt.type === "part.done") return evt.part;
  return undefined;
}

describe("CodexAppServerAdapter", () => {
  it("emits turn and assistant message lifecycle from turn/started", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    const events = transformer.process({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress" },
      },
    });

    expect(events).toEqual([
      { type: "turn.started", turnId: "turn-1" },
      { type: "message.created", messageId: "msg-1", role: "assistant" },
    ]);
  });

  it("streams assistant message deltas into one text part", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    const first = transformer.process({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-item", delta: "Hello" },
    });
    const second = transformer.process({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-item", delta: " world" },
    });

    expect(first[0]).toMatchObject({ type: "part.created" });
    expect(partFrom(first[0])).toMatchObject({ type: "TEXT", text: "Hello" });
    expect(second[0]).toMatchObject({ type: "part.delta", delta: " world" });
    expect(transformer.getParts()[0]).toMatchObject({ type: "TEXT", text: "Hello world" });
  });

  it("creates and completes command execution tool parts", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    const started = transformer.process({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "bun test",
          cwd: "/tmp/project",
          status: "inProgress",
        },
      },
    });

    const completed = transformer.process({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "bun test",
          cwd: "/tmp/project",
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(partFrom(started[0])).toMatchObject({
      type: "TOOL",
      toolName: "shell",
      kind: "bash",
      state: expect.objectContaining({ status: "RUNNING" }),
    });
    expect(partFrom(completed[0])).toMatchObject({
      type: "TOOL",
      state: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("maps Codex collaboration spawn calls to task tool parts", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    const events = transformer.process({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "agent-tool-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "review the API layer",
          model: "gpt-5.3-codex",
          reasoningEffort: "medium",
          agentsStates: {},
        },
      },
    });

    expect(partFrom(events[0])).toMatchObject({
      type: "TOOL",
      toolName: "spawn_agent",
      kind: "task",
      subagent: {
        type: "codex",
        description: "review the API layer",
        model: "gpt-5.3-codex",
        agentId: "sub-thread-1",
      },
    });
  });

  it("maps Codex wait results to child subagent messages under the spawn tool", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    transformer.process({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-tool-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "review the API layer",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agentsStates: {},
        },
      },
    });

    transformer.process({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "wait-tool-1",
          tool: "wait",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {
            "sub-thread-1": { status: "running" },
          },
        },
      },
    });

    const events = transformer.process({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "wait-tool-1",
          tool: "wait",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {
            "sub-thread-1": {
              status: "completed",
              message: "SUBAGENT_OK",
              agentNickname: "Explorer",
            },
          },
        },
      },
    });

    const childCreated = events.find((event) => event.type === "message.created");
    const childPart = events
      .filter((event) => event.type === "part.done")
      .map((event) => event.part)
      .find((part) => part.type === "TEXT" && part.text === "SUBAGENT_OK");
    const childDone = events.find(
      (event) => event.type === "message.done" && event.messageId === childCreated?.messageId
    );
    const waitPart = events
      .filter((event) => event.type === "part.done")
      .map((event) => event.part)
      .find((part) => part.type === "TOOL" && part.toolName === "wait_agent");

    expect(childCreated).toMatchObject({
      type: "message.created",
      parentToolCallId: "spawn-tool-1",
    });
    expect(childPart).toMatchObject({
      type: "TEXT",
      text: "SUBAGENT_OK",
      parentToolCallId: "spawn-tool-1",
    });
    expect(childDone).toMatchObject({
      type: "message.done",
      parentToolCallId: "spawn-tool-1",
      parts: [expect.objectContaining({ text: "SUBAGENT_OK" })],
    });
    expect(waitPart).toMatchObject({
      type: "TOOL",
      state: expect.objectContaining({
        status: "COMPLETED",
        content: [
          {
            type: "agent_result",
            agentId: "sub-thread-1",
            status: "completed",
            label: "Explorer",
            message: "SUBAGENT_OK",
          },
        ],
      }),
    });
    expect(transformer.getParts().some((part) => part.id === childPart?.id)).toBe(false);
  });

  it("routes live child-thread events under the spawn tool", () => {
    const transformer = codexAppServerAdapter.createTransformer(makeCtx());

    transformer.process({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-tool-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "review the API layer",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agentsStates: {},
        },
      },
    });

    expect((transformer as any).isKnownSubagentThread("sub-thread-1")).toBe(true);

    const started = transformer.process({
      method: "turn/started",
      params: {
        threadId: "sub-thread-1",
        turn: { id: "sub-turn-1", status: "inProgress" },
      },
    });
    const delta = transformer.process({
      method: "item/agentMessage/delta",
      params: {
        threadId: "sub-thread-1",
        turnId: "sub-turn-1",
        itemId: "sub-msg-1",
        delta: "Subagent live",
      },
    });
    const completed = transformer.process({
      method: "turn/completed",
      params: {
        threadId: "sub-thread-1",
        turn: { id: "sub-turn-1", status: "completed" },
      },
    });

    const childCreated = started.find((event) => event.type === "message.created");
    const childPart = partFrom(delta.find((event) => event.type === "part.created")!);
    const childDone = completed.find((event) => event.type === "message.done");

    expect(childCreated).toMatchObject({
      type: "message.created",
      parentToolCallId: "spawn-tool-1",
    });
    expect(childPart).toMatchObject({
      type: "TEXT",
      messageId: childCreated?.messageId,
      text: "Subagent live",
      parentToolCallId: "spawn-tool-1",
    });
    expect(childDone).toMatchObject({
      type: "message.done",
      messageId: childCreated?.messageId,
      parentToolCallId: "spawn-tool-1",
      parts: [expect.objectContaining({ text: "Subagent live" })],
    });
  });
});
