import { describe, expect, it } from "vitest";
import { codexSdkAdapter } from "../messages/codex-sdk-adapter";
import type { StreamContext, PartEvent } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

/** Extract part from a part.created or part.done event */
function partFrom(evt: PartEvent) {
  if (evt.type === "part.created" || evt.type === "part.done") return evt.part;
  return undefined;
}

describe("CodexSdkAdapter", () => {
  describe("text streaming", () => {
    it("creates a text part on item.started with agent_message via part.created", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.created" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TEXT",
        text: "Hello",
        state: "STREAMING",
      });
    });

    it("emits only the delta text on item.updated via part.delta", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      const events = transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "Hello world" },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "part.delta",
        delta: " world",
      });
    });

    it("accumulates text internally for getParts()", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "Hello world" },
      });

      const allParts = transformer.getParts();
      const text = allParts.find((p) => p.type === "TEXT");
      expect(text).toMatchObject({ text: "Hello world", state: "STREAMING" });
    });

    it("finalizes text on item.completed via part.done", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "H" },
      });

      transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "Hello" },
      });

      const events = transformer.process({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "Hello world" },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "DONE",
      });
    });

    it("reuses the same part ID across started/updated/completed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const startedEvents = transformer.process({
        type: "item.started",
        item: { id: "item-1", type: "agent_message", text: "a" },
      });
      const started = partFrom(startedEvents[0])!;
      expect(started).toMatchObject({ type: "TEXT", text: "a" });

      const updatedEvents = transformer.process({
        type: "item.updated",
        item: { id: "item-1", type: "agent_message", text: "ab" },
      });
      // Updated is a part.delta event — check partId matches
      expect(updatedEvents[0]).toMatchObject({
        type: "part.delta",
        partId: started.id,
        delta: "b",
      });

      const completedEvents = transformer.process({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "abc" },
      });
      const completed = partFrom(completedEvents[0])!;
      // On DONE, emits the full text
      expect(completed).toMatchObject({ type: "TEXT", text: "abc" });
      expect(completed.id).toBe(started.id);
    });
  });

  describe("reasoning", () => {
    it("streams reasoning through the item lifecycle with delta emissions", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const startedEvents = transformer.process({
        type: "item.started",
        item: { id: "r-1", type: "reasoning", text: "Let me" },
      });

      const started = partFrom(startedEvents[0])!;
      expect(started).toMatchObject({ type: "REASONING", text: "Let me", state: "STREAMING" });

      const updatedEvents = transformer.process({
        type: "item.updated",
        item: { id: "r-1", type: "reasoning", text: "Let me think" },
      });

      // Emitted delta is only the new " think"
      expect(updatedEvents[0]).toMatchObject({
        type: "part.delta",
        partId: started.id,
        delta: " think",
      });

      const completedEvents = transformer.process({
        type: "item.completed",
        item: { id: "r-1", type: "reasoning", text: "Let me think about this" },
      });

      const completed = partFrom(completedEvents[0])!;
      // On DONE, emits the full text
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

      const events = transformer.process({
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "",
          status: "in_progress",
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.created" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        toolName: "shell",
        kind: "bash",
        title: "ls -la",
        state: expect.objectContaining({
          status: "RUNNING",
          input: { command: "ls -la" },
        }),
      });
    });

    it("completes tool part on item.completed with success via part.done", () => {
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

      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "COMPLETED" }),
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

      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "ERROR" }),
      });
    });
  });

  describe("file changes", () => {
    it("creates and completes file change tool parts", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const startEvents = transformer.process({
        type: "item.started",
        item: {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/foo.ts", kind: "update" }],
          status: "completed",
        },
      });

      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({ type: "part.created" });
      expect(partFrom(startEvents[0])).toMatchObject({
        type: "TOOL",
        toolName: "apply_patch",
        kind: "write",
        title: "Edit src/foo.ts",
        state: expect.objectContaining({ status: "RUNNING" }),
      });

      const endEvents = transformer.process({
        type: "item.completed",
        item: {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/foo.ts", kind: "update" }],
          status: "completed",
        },
      });

      expect(endEvents).toHaveLength(1);
      expect(endEvents[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(endEvents[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "COMPLETED" }),
      });
    });

    it("sets multiple file locations", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const events = transformer.process({
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

      expect(partFrom(events[0])).toMatchObject({
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

      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "part.done" });
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        toolName: "github/list_repos",
        kind: "mcp",
        state: expect.objectContaining({ status: "COMPLETED" }),
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

      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(partFrom(events[0])).toMatchObject({
        type: "TOOL",
        state: expect.objectContaining({ status: "ERROR", error: "Connection refused" }),
      });
    });
  });

  describe("turn lifecycle", () => {
    it("emits turn.started and message.created on turn.started", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const events = transformer.process({ type: "turn.started" });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "turn.started" });
      expect(events[1]).toMatchObject({ type: "message.created" });
    });

    it("emits message.done and turn.completed with usage on turn.completed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 },
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "message.done" });
      const turnCompleted = events.find((e) => e.type === "turn.completed");
      expect(turnCompleted).toMatchObject({
        type: "turn.completed",
        finishReason: "end_turn",
        tokens: expect.objectContaining({ input: 100, output: 50, cacheRead: 20 }),
      });
    });

    it("emits message.done and error turn.completed on turn.failed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "turn.failed",
        error: { message: "Rate limit exceeded" },
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "message.done" });
      const turnCompleted = events.find((e) => e.type === "turn.completed");
      expect(turnCompleted).toMatchObject({
        type: "turn.completed",
        finishReason: "error",
      });
    });

    it("returns empty for thread.started", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const events = transformer.process({ type: "thread.started", thread_id: "t-1" });
      expect(events).toHaveLength(0);
    });

    it("returns empty for error events", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const events = transformer.process({ type: "error", message: "something" });
      expect(events).toHaveLength(0);
    });
  });

  describe("ignored item types", () => {
    it("returns empty for web_search items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const events = transformer.process({
        type: "item.started",
        item: { id: "ws-1", type: "web_search", query: "test" },
      });
      expect(events).toHaveLength(0);
    });

    it("returns empty for todo_list items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const events = transformer.process({
        type: "item.completed",
        item: { id: "todo-1", type: "todo_list", items: [{ text: "do stuff", completed: false }] },
      });
      expect(events).toHaveLength(0);
    });

    it("returns empty for error items", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());
      const events = transformer.process({
        type: "item.started",
        item: { id: "err-1", type: "error", message: "non-fatal" },
      });
      expect(events).toHaveLength(0);
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
    });

    it("returns all parts (excluding turn events) from getParts()", () => {
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
      // Parts only include actual content parts (reasoning + text), not turn lifecycle events
      expect(result.parts).toHaveLength(2);
      expect(result.parts.map((p) => p.type)).toEqual(["REASONING", "TEXT"]);
    });

    it("returns error finishReason via events on turn.failed", () => {
      const transformer = codexSdkAdapter.createTransformer(makeCtx());

      transformer.process({ type: "turn.failed", error: { message: "fail" } });

      const result = transformer.finish();
      // finish() should not re-emit turn.completed since it was already emitted in process()
      // The finishReason is captured in the events returned by process()
      // Check that the events from finish() don't duplicate turn.completed
      const turnCompletedEvents = result.events.filter((e) => e.type === "turn.completed");
      expect(turnCompletedEvents).toHaveLength(0); // already emitted in process()
    });
  });
});
