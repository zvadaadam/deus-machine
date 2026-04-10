import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../messages/claude-adapter";
import type { ClaudeCodeEvent } from "../messages/claude-events";
import type { StreamContext } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

describe("ClaudeCodeAdapter", () => {
  describe("non-streaming (assistant events)", () => {
    it("transforms a text block into a TextPart", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const event: ClaudeCodeEvent = {
        type: "assistant",
        message: {
          id: "msg_abc",
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      };

      const parts = transformer.process(event);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "DONE",
        sessionId: "sess-1",
        messageId: "msg-1",
      });
    });

    it("transforms a thinking block into a ReasoningPart", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const event: ClaudeCodeEvent = {
        type: "assistant",
        message: {
          id: "msg_abc",
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me think..." }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      };

      const parts = transformer.process(event);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "REASONING",
        text: "Let me think...",
        state: "DONE",
      });
    });

    it("transforms a tool_use block into a ToolPart", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const event: ClaudeCodeEvent = {
        type: "assistant",
        message: {
          id: "msg_abc",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      };

      const parts = transformer.process(event);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolCallId: "tool_1",
        toolName: "Bash",
        state: {
          status: "RUNNING",
          input: { command: "ls -la" },
        },
      });
    });

    it("handles mixed content blocks", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const event: ClaudeCodeEvent = {
        type: "assistant",
        message: {
          id: "msg_abc",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Planning..." },
            { type: "text", text: "Here's what I'll do:" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/foo" } },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      };

      const parts = transformer.process(event);
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatchObject({ type: "REASONING" });
      expect(parts[1]).toMatchObject({ type: "TEXT" });
      expect(parts[2]).toMatchObject({ type: "TOOL" });
    });
  });

  describe("streaming (stream_event)", () => {
    it("accumulates text deltas into a single TextPart", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const parts2 = transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(parts2).toHaveLength(1);
      expect(parts2[0]).toMatchObject({
        type: "TEXT",
        text: "Hello world",
        state: "STREAMING",
      });
    });

    it("finalizes text parts to DONE on content_block_stop", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      transformer.process({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const allParts = transformer.getParts();
      const textPart = allParts.find((p) => p.type === "TEXT");
      expect(textPart).toBeDefined();
      expect(textPart!.state).toBe("DONE");
    });

    it("builds tool parts from streaming input_json_delta", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":' },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"ls -la"}' },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const parts = transformer.process({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolCallId: "tool_1",
        toolName: "Bash",
        state: {
          status: "RUNNING",
          input: { command: "ls -la" },
        },
      });
    });
  });

  describe("tool results (user events)", () => {
    it("completes a tool part when tool_result arrives", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Create tool part
      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Complete with tool result
      const parts = transformer.process({
        type: "user",
        message: {
          id: "msg_2",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_1", content: "file1.txt\nfile2.txt" },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolCallId: "tool_1",
        state: {
          status: "COMPLETED",
          output: "file1.txt\nfile2.txt",
        },
      });
    });

    it("marks tool as error when is_error is true", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "bad" } }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const parts = transformer.process({
        type: "user",
        message: {
          id: "msg_2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "command not found",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        state: {
          status: "ERROR",
          error: "command not found",
        },
      });
    });
  });

  describe("result events", () => {
    it("emits StepFinishPart on result/success", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "STEP_FINISH",
        finishReason: "end_turn",
        tokens: { input: 100, output: 50 },
        cost: 0.005,
      });
    });

    it("finish() returns accumulated usage", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50 },
        total_cost_usd: 0.01,
      });

      const result = transformer.finish();
      expect(result.usage).toMatchObject({ input: 200, output: 100, cacheRead: 50 });
      expect(result.cost).toBe(0.01);
      expect(result.finishReason).toBe("end_turn");
    });
  });

  describe("system events", () => {
    it("emits CompactionPart on compact_boundary", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 50000 },
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "COMPACTION",
        auto: true,
        preTokens: 50000,
      });
    });

    it("ignores init and status system events", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const parts1 = transformer.process({
        type: "system",
        subtype: "init",
        session_id: "s_123",
      });
      expect(parts1).toHaveLength(0);

      const parts2 = transformer.process({
        type: "system",
        subtype: "status",
        status: "ready",
        session_id: "s_123",
      });
      expect(parts2).toHaveLength(0);
    });
  });

  describe("subagent tracking", () => {
    it("detects Task tool and sets subagent metadata", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const parts = transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "task_1",
              name: "Task",
              input: { subagent_type: "code-reviewer", model: "sonnet" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TOOL",
        toolName: "Task",
        kind: "task",
        subagent: { type: "code-reviewer", model: "sonnet" },
      });
    });

    it("tags parts with parentToolCallId for subagent events", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Parent creates Task tool
      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task_1", name: "Task", input: { subagent_type: "dev" } },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Subagent produces text
      const parts = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Working on it..." }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "TEXT",
        text: "Working on it...",
        parentToolCallId: "task_1",
      });
    });
  });
});
