import { describe, expect, it } from "vitest";
import { codexAdapter } from "../messages/codex-adapter";
import type { CodexEvent } from "../messages/codex-events";
import type { StreamContext } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

describe("CodexAdapter", () => {
  describe("text streaming", () => {
    it("accumulates text deltas", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_message_delta", delta: "Hello" });
      const parts = transformer.process({ type: "agent_message_delta", delta: " world" });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "STREAMING",
      });
    });

    it("finalizes text on agent_message", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_message_delta", delta: "Hel" });
      const parts = transformer.process({ type: "agent_message", message: "Hello world" });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "DONE",
      });
    });
  });

  describe("reasoning", () => {
    it("accumulates reasoning deltas", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({ type: "agent_reasoning_delta", delta: "Let me " });
      const parts = transformer.process({ type: "agent_reasoning_delta", delta: "think..." });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "REASONING",
        text: "Let me think...",
        state: "STREAMING",
      });
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
    it("creates a running tool part on exec_command_begin", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "exec_command_begin",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls", "-la"],
        cwd: "/home/user",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolCallId: "call_1",
        toolName: "shell",
        kind: "bash",
        title: "ls -la",
        state: {
          status: "RUNNING",
          input: { command: "ls -la", cwd: "/home/user" },
        },
      });
    });

    it("completes tool part on exec_command_end", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "exec_command_begin",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls"],
        cwd: "/home",
      });

      const parts = transformer.process({
        type: "exec_command_end",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["ls"],
        cwd: "/home",
        stdout: "file1.txt",
        stderr: "",
        exit_code: 0,
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "COMPLETED" },
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

      const parts = transformer.process({
        type: "exec_command_end",
        call_id: "call_1",
        turn_id: "turn_1",
        command: ["bad-cmd"],
        cwd: "/home",
        stdout: "",
        stderr: "command not found",
        exit_code: 127,
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "ERROR", error: "command not found" },
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

      const parts = transformer.process({
        type: "patch_apply_end",
        call_id: "call_2",
        turn_id: "turn_1",
        success: true,
        changes: { "src/foo.ts": { type: "update", unified_diff: "+new line" } },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolName: "apply_patch",
        kind: "write",
        state: { status: "COMPLETED" },
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

      const parts = transformer.process({
        type: "mcp_tool_call_end",
        call_id: "call_3",
        invocation: { server: "github", tool: "list_repos", arguments: {} },
        result: { Ok: { content: [{ type: "text", text: "repo1, repo2" }] } },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolName: "github/list_repos",
        kind: "mcp",
        state: { status: "COMPLETED" },
      });
    });
  });

  describe("turn lifecycle", () => {
    it("emits StepStartPart on task_started", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const parts = transformer.process({ type: "task_started", turn_id: "turn_1" });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ type: "STEP_START" });
    });

    it("emits StepFinishPart on task_complete", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "task_complete",
        turn_id: "turn_1",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "STEP_FINISH",
        finishReason: "end_turn",
      });
    });

    it("emits cancelled finish on turn_aborted with interrupted", () => {
      const transformer = codexAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "turn_aborted",
        turn_id: "turn_1",
        reason: "interrupted",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "STEP_FINISH",
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
