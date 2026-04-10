import { describe, expect, it } from "vitest";
import { codexSdkAdapter } from "../messages/codex-sdk-adapter";
import type { StreamContext } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

describe("CodexSdkAdapter", () => {
  describe("text streaming", () => {
    it("creates a text part on item.started with agent_message", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello",
        state: "STREAMING",
      });
    });

    it("updates text on item.updated", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      const parts = transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "Hello world" },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "STREAMING",
      });
    });

    it("finalizes text on item.completed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "H" },
      });

      transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      const parts = transformer.process({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "Hello world" },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "DONE",
      });
    });

    it("reuses the same part ID across started/updated/completed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const [started] = transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "a" },
      });

      const [updated] = transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "ab" },
      });

      const [completed] = transformer.process({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "abc" },
      });

      expect(started.id).toBe(updated.id);
      expect(updated.id).toBe(completed.id);
    });
  });

  describe("reasoning", () => {
    it("streams reasoning through the item lifecycle", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const [started] = transformer.process({
        type: "item.started",
        item: { id: "r-1", type: "reasoning", text: "Let me" },
      });

      expect(started).toMatchObject({ type: "REASONING", text: "Let me", state: "STREAMING" });

      const [updated] = transformer.process({
        type: "item.updated",
        item: { id: "r-1", type: "reasoning", text: "Let me think" },
      });

      expect(updated).toMatchObject({
        type: "REASONING",
        text: "Let me think",
        state: "STREAMING",
      });
      expect(updated.id).toBe(started.id);

      const [completed] = transformer.process({
        type: "item.completed",
        item: { id: "r-1", type: "reasoning", text: "Let me think about this" },
      });

      expect(completed).toMatchObject({
        type: "REASONING",
        text: "Let me think about this",
        state: "DONE",
      });
    });
  });

  describe("shell commands", () => {
    it("creates a running tool part on item.started with command_execution", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "",
          status: "in_progress",
        },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolName: "shell",
        kind: "bash",
        title: "ls -la",
        state: {
          status: "RUNNING",
          input: { command: "ls -la" },
        },
      });
    });

    it("completes tool part on item.completed with success", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          status: "in_progress",
        },
      });

      const parts = transformer.process({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "file1.txt\nfile2.txt",
          exit_code: 0,
          status: "completed",
        },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "COMPLETED" },
      });
    });

    it("marks error on non-zero exit code", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: {
          id: "cmd-2",
          type: "command_execution",
          command: "bad-cmd",
          aggregated_output: "",
          status: "in_progress",
        },
      });

      const parts = transformer.process({
        type: "item.completed",
        item: {
          id: "cmd-2",
          type: "command_execution",
          command: "bad-cmd",
          aggregated_output: "command not found",
          exit_code: 127,
          status: "failed",
        },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "ERROR" },
      });
    });
  });

  describe("file changes", () => {
    it("creates and completes file change tool parts", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const startParts = transformer.process({
        type: "item.started",
        item: {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/foo.ts", kind: "update" }],
          status: "completed",
        },
      });

      expect(startParts).toHaveLength(1);
      expect(startParts[0]).toMatchObject({
        type: "TOOL",
        toolName: "apply_patch",
        kind: "write",
        title: "Edit src/foo.ts",
        state: { status: "RUNNING" },
      });

      const endParts = transformer.process({
        type: "item.completed",
        item: {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/foo.ts", kind: "update" }],
          status: "completed",
        },
      });

      expect(endParts).toHaveLength(1);
      expect(endParts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "COMPLETED" },
      });
    });

    it("sets multiple file locations", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "item.started",
        item: {
          id: "fc-2",
          type: "file_change",
          changes: [
            { path: "src/a.ts", kind: "update" },
            { path: "src/b.ts", kind: "add" },
          ],
          status: "completed",
        },
      });

      expect(parts[0]).toMatchObject({
        title: "Edit 2 files",
        locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      });
    });
  });

  describe("MCP tool calls", () => {
    it("creates and completes MCP tool parts", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "github",
          tool: "list_repos",
          arguments: { org: "acme" },
          status: "in_progress",
        },
      });

      const parts = transformer.process({
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "github",
          tool: "list_repos",
          arguments: { org: "acme" },
          result: { content: [], structured_content: null },
          status: "completed",
        },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolName: "github/list_repos",
        kind: "mcp",
        state: { status: "COMPLETED" },
      });
    });

    it("marks MCP error on failure", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "db",
          tool: "query",
          arguments: {},
          status: "in_progress",
        },
      });

      const parts = transformer.process({
        type: "item.completed",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "db",
          tool: "query",
          arguments: {},
          error: { message: "Connection refused" },
          status: "failed",
        },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: { status: "ERROR", error: "Connection refused" },
      });
    });
  });

  describe("turn lifecycle", () => {
    it("emits StepStartPart on turn.started", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({ type: "turn.started" });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ type: "STEP_START" });
    });

    it("emits StepFinishPart with usage on turn.completed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "STEP_FINISH",
        finishReason: "end_turn",
        tokens: { input: 100, output: 50, cacheRead: 20 },
      });
    });

    it("emits error finish on turn.failed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "turn.failed",
        error: { message: "Rate limit exceeded" },
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "STEP_FINISH",
        finishReason: "error",
      });
    });

    it("returns empty for thread.started", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const parts = transformer.process({ type: "thread.started", thread_id: "t-1" });
      expect(parts).toHaveLength(0);
    });

    it("returns empty for error events", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const parts = transformer.process({ type: "error", message: "something" });
      expect(parts).toHaveLength(0);
    });
  });

  describe("ignored item types", () => {
    it("returns empty for web_search items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const parts = transformer.process({
        type: "item.started",
        item: { id: "ws-1", type: "web_search", query: "test" },
      });
      expect(parts).toHaveLength(0);
    });

    it("returns empty for todo_list items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const parts = transformer.process({
        type: "item.completed",
        item: { id: "todo-1", type: "todo_list", items: [{ text: "do stuff", completed: false }] },
      });
      expect(parts).toHaveLength(0);
    });

    it("returns empty for error items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const parts = transformer.process({
        type: "item.started",
        item: { id: "err-1", type: "error", message: "non-fatal" },
      });
      expect(parts).toHaveLength(0);
    });
  });

  describe("finish()", () => {
    it("returns accumulated usage from turn.completed events", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      });

      const result = transformer.finish();
      expect(result.usage).toMatchObject({ input: 100, output: 50, cacheRead: 10 });
      expect(result.finishReason).toBe("end_turn");
    });

    it("returns all parts including text, reasoning, and tools", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({ type: "turn.started" });
      transformer.process({
        type: "item.completed",
        item: { id: "r-1", type: "reasoning", text: "thinking" },
      });
      transformer.process({
        type: "item.completed",
        item: { id: "t-1", type: "agent_message", text: "output" },
      });
      transformer.process({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 25, cached_input_tokens: 0 },
      });

      const result = transformer.finish();
      expect(result.parts).toHaveLength(4); // step_start + reasoning + text + step_finish
      expect(result.parts.map((p) => p.type)).toEqual([
        "STEP_START",
        "REASONING",
        "TEXT",
        "STEP_FINISH",
      ]);
    });

    it("returns error finishReason on turn.failed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({ type: "turn.failed", error: { message: "fail" } });

      const result = transformer.finish();
      expect(result.finishReason).toBe("error");
    });
  });
});
