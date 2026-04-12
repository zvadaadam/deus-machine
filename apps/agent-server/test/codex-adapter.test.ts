import { describe, expect, it } from "vitest";
import { codexAdapter } from "../messages/codex-adapter";
import type { CodexEvent } from "../messages/codex-events";
import type { StreamContext, PartEvent } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

/** Extract part from a part.created or part.done event */
function partFrom(evt: PartEvent) {
  if (evt.type === "part.created" || evt.type === "part.done") return evt.part;
  return undefined;
}

describe("CodexAdapter", () => {
  describe("text streaming", () => {
    it("emits part.created on first delta, then part.delta on subsequent", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const first = transformer.process({ type: "agent_message_delta", delta: "Hello" });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ type: "part.created" });
      expect(partFrom(first[0])).toMatchObject({ type: "TEXT", text: "Hello", state: "STREAMING" });

      const second = transformer.process({ type: "agent_message_delta", delta: " world" });
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ type: "part.delta", delta: " world" });
    });

    it("accumulates text internally for getParts()", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_message_delta", delta: "Hello" });
      transformer.process({ type: "agent_message_delta", delta: " world" });

      const allParts = transformer.getParts();
      const text = allParts.find((p) => p.type === "TEXT");
      expect(text).toMatchObject({ text: "Hello world", state: "STREAMING" });
    });

    it("finalizes text on agent_message via part.done", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_message_delta", delta: "Hel" });
      const events = transformer.process({ type: "agent_message", message: "Hello world" });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "DONE",
      });
    });
  });

  describe("reasoning", () => {
    it("emits part.created on first reasoning delta, then part.delta on subsequent", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const first = transformer.process({ type: "agent_reasoning_delta", delta: "Let me " });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ type: "part.created" });
      expect(partFrom(first[0])).toMatchObject({
        type: "REASONING",
        text: "Let me ",
        state: "STREAMING",
      });

      const second = transformer.process({ type: "agent_reasoning_delta", delta: "think..." });
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ type: "part.delta", delta: "think..." });
    });

    it("accumulates reasoning internally for getParts()", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_reasoning_delta", delta: "Let me " });
      transformer.process({ type: "agent_reasoning_delta", delta: "think..." });

      const allParts = transformer.getParts();
      const reasoning = allParts.find((p) => p.type === "REASONING");
      expect(reasoning).toMatchObject({ text: "Let me think...", state: "STREAMING" });
    });

    it("finalizes reasoning when text starts", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_reasoning_delta", delta: "thinking" });
      transformer.process({ type: "agent_message_delta", delta: "output" });

      const allParts = transformer.getParts();
      const reasoning = allParts.find((p) => p.type === "REASONING");
      expect(reasoning).toMatchObject({ state: "DONE" });
    });
  });

  describe("shell commands", () => {
    it("creates a running tool part on exec_command_begin via part.created", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "exec_command_begin",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls", "-la"],
        cwd: "/home/user",
      });

      expect(events).toHaveLength(1);
      const partCreated = events.find((e) => e.type === "part.created");
      expect(partCreated).toBeDefined();
      expect(partFrom(partCreated!)).toMatchObject({
        type: "TOOL",
        toolCallId: "call_1",
        toolName: "shell",
        kind: "bash",
        title: "ls -la",
        state: expect.objectContaining({
          status: "RUNNING",
          input: { command: "ls -la", cwd: "/home/user" },
        }),
      });
    });

    it("completes tool part on exec_command_end via part.done", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "exec_command_begin",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls"],
        cwd: "/home",
      });

      const events = transformer.process({
        type: "exec_command_end",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls"],
        cwd: "/home",
        stdout: "file1.txt",
        stderr: "",
        exit_code: 0,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "COMPLETED" }),
      });
    });

    it("marks error on non-zero exit code", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "exec_command_begin",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["bad-cmd"],
        cwd: "/home",
      });

      const events = transformer.process({
        type: "exec_command_end",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["bad-cmd"],
        cwd: "/home",
        stdout: "",
        stderr: "command not found",
        exit_code: 127,
      });

      expect(events).toHaveLength(1);
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "ERROR", error: "command not found" }),
      });
    });
  });

  describe("file patches", () => {
    it("creates and completes patch tool parts", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "patch_apply_begin",
        call_id: "call_2",
        turn_id: "turn_1",
        changes: { "src/foo.ts": { type: "update", unified_diff: "+new line" } },
      });

      const events = transformer.process({
        type: "patch_apply_end",
        call_id: "call_2",
        turn_id: "turn_1",
        success: true,
        changes: { "src/foo.ts": { type: "update", unified_diff: "+new line" } },
      });

      expect(events).toHaveLength(1);
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        toolName: "apply_patch",
        kind: "write",
        state: expect.objectContaining({ status: "COMPLETED" }),
      });
    });
  });

  describe("MCP tool calls", () => {
    it("creates and completes MCP tool parts", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "mcp_tool_call_begin",
        call_id: "call_3",
        invocation: { server: "github", tool: "list_repos", arguments: {} },
      });

      const events = transformer.process({
        type: "mcp_tool_call_end",
        call_id: "call_3",
        invocation: { server: "github", tool: "list_repos", arguments: {} },
        result: { Ok: { content: [{ type: "text", text: "repo1, repo2" }] } },
      });

      expect(events).toHaveLength(1);
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        toolName: "github/list_repos",
        kind: "mcp",
        state: expect.objectContaining({ status: "COMPLETED" }),
      });
    });
  });

  describe("turn lifecycle", () => {
    it("emits turn.started and message.created on task_started", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const events = transformer.process({ type: "task_started", turn_id: "turn_1" });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "turn.started" });
      expect(events[1]).toMatchObject({ type: "message.created" });
    });

    it("emits message.done and turn.completed on task_complete", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "task_complete",
        turn_id: "turn_1",
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "message.done" });
      expect(events[1]).toMatchObject({
        type: "turn.completed",
        finishReason: "end_turn",
      });
    });

    it("emits message.done and cancelled turn.completed on turn_aborted with interrupted", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "turn_aborted",
        turn_id: "turn_1",
        reason: "interrupted",
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "message.done" });
      expect(events[1]).toMatchObject({
        type: "turn.completed",
        finishReason: "cancelled",
      });
    });
  });

  describe("token counting", () => {
    it("accumulates token usage across events", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      transformer.process({
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 200, output_tokens: 100 },
        },
      });

      const result = transformer.finish();
      expect(result.usage).toMatchObject({ input: 300, output: 150 });
    });
  });

  describe("finish()", () => {
    it("finalizes all streaming parts", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_reasoning_delta", delta: "thinking" });
      transformer.process({ type: "agent_message_delta", delta: "output" });

      const result = transformer.finish();
      const parts = result.parts;

      const reasoning = parts.find((p) => p.type === "REASONING");
      const text = parts.find((p) => p.type === "TEXT");
      expect(reasoning?.state).toBe("DONE");
      expect(text?.state).toBe("DONE");
    });
  });
});
