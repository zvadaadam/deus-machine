import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../messages/claude-adapter";
import type { ClaudeCodeEvent } from "../messages/claude-events";
import type { StreamContext, PartEvent } from "../messages/adapter";

function makeCtx(): StreamContext {
  return { sessionId: "sess-1", messageId: "msg-1" };
}

/** Extract part from a part.created or part.done event */
function partFrom(evt: PartEvent) {
  if (evt.type === "part.created" || evt.type === "part.done") return evt.part;
  return undefined;
}

/** Find the first part.created or part.done event with the given part type */
function findPartEvent(events: PartEvent[], partType: string) {
  return events.find(
    (e) => (e.type === "part.created" || e.type === "part.done") && e.part.type === partType
  );
}

describe("ClaudeCodeAdapter", () => {
  describe("non-streaming (assistant events)", () => {
    it("transforms a text block into a TextPart via part.done event", () => {
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

      const events = transformer.process(event);
      // message.created + part.done + message.done
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "message.created" });
      expect(events[1]).toMatchObject({
        type: "part.done",
        part: expect.objectContaining({
          type: "TEXT",
          text: "Hello world",
          state: "DONE",
          sessionId: "sess-1",
          messageId: "msg-1",
        }),
      });
      expect(events[2]).toMatchObject({ type: "message.done" });
    });

    it("transforms a thinking block into a ReasoningPart via part.done event", () => {
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

      const events = transformer.process(event);
      // message.created + part.done + message.done
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "message.created" });
      const partEvt = events.find((e) => e.type === "part.done");
      expect(partEvt).toMatchObject({
        type: "part.done",
        part: expect.objectContaining({
          type: "REASONING",
          text: "Let me think...",
          state: "DONE",
        }),
      });
      expect(events[2]).toMatchObject({ type: "message.done" });
    });

    it("transforms a tool_use block into a ToolPart via part.created event", () => {
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

      const events = transformer.process(event);
      // message.created + part.created + message.done
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "message.created" });
      const partEvt = events.find((e) => e.type === "part.created");
      expect(partEvt).toMatchObject({
        type: "part.created",
        part: expect.objectContaining({
          type: "TOOL",
          toolCallId: "tool_1",
          toolName: "Bash",
          state: expect.objectContaining({
            status: "RUNNING",
            input: { command: "ls -la" },
          }),
        }),
      });
      expect(events[2]).toMatchObject({ type: "message.done" });
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

      const events = transformer.process(event);
      // message.created + 3 part events + message.done
      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ type: "message.created" });
      expect(partFrom(events[1])).toMatchObject({ type: "REASONING" });
      expect(partFrom(events[2])).toMatchObject({ type: "TEXT" });
      expect(partFrom(events[3])).toMatchObject({ type: "TOOL" });
      expect(events[4]).toMatchObject({ type: "message.done" });
    });
  });

  describe("streaming (stream_event)", () => {
    it("accumulates text deltas emitting part.delta events", () => {
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

      const events2 = transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(events2).toHaveLength(1);
      expect(events2[0]).toMatchObject({
        type: "part.delta",
        delta: " world",
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

      const events = transformer.process({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Should emit part.created with the finalized tool part
      const toolEvent = events.find(
        (e) => (e.type === "part.created" || e.type === "part.done") && e.part.type === "TOOL"
      );
      expect(toolEvent).toBeDefined();
      expect(partFrom(toolEvent!)).toMatchObject({
        type: "TOOL",
        toolCallId: "tool_1",
        toolName: "Bash",
        state: expect.objectContaining({
          status: "RUNNING",
          input: { command: "ls -la" },
        }),
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
      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "part.done",
        part: expect.objectContaining({
          type: "TOOL",
          toolCallId: "tool_1",
          state: expect.objectContaining({
            status: "COMPLETED",
            output: "file1.txt\nfile2.txt",
          }),
        }),
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

      const events = transformer.process({
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

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "part.done",
        part: expect.objectContaining({
          type: "TOOL",
          state: expect.objectContaining({
            status: "ERROR",
            error: "command not found",
          }),
        }),
      });
    });
  });

  describe("result events", () => {
    it("emits turn.completed on result/success", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
      });

      const turnCompleted = events.find((e) => e.type === "turn.completed");
      expect(turnCompleted).toBeDefined();
      expect(turnCompleted).toMatchObject({
        type: "turn.completed",
        finishReason: "end_turn",
        tokens: expect.objectContaining({ input: 100, output: 50 }),
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
    });
  });

  describe("system events", () => {
    it("emits CompactionPart on compact_boundary", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 50000 },
        session_id: "s_123",
      });

      // Should emit part.created and part.done for the compaction part
      const createdEvent = events.find(
        (e) => e.type === "part.created" && e.part.type === "COMPACTION"
      );
      expect(createdEvent).toBeDefined();
      expect(partFrom(createdEvent!)).toMatchObject({
        type: "COMPACTION",
        auto: true,
        preTokens: 50000,
      });
    });

    it("ignores init and status system events", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const events1 = transformer.process({
        type: "system",
        subtype: "init",
        session_id: "s_123",
      });
      expect(events1).toHaveLength(0);

      const events2 = transformer.process({
        type: "system",
        subtype: "status",
        status: "ready",
        session_id: "s_123",
      });
      expect(events2).toHaveLength(0);
    });
  });

  describe("subagent tracking", () => {
    it("detects Task tool and sets subagent metadata", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const events = transformer.process({
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

      // message.created + part.created + message.done
      expect(events).toHaveLength(3);
      const partEvt = events.find((e) => e.type === "part.created");
      expect(partEvt).toMatchObject({
        type: "part.created",
        part: expect.objectContaining({
          type: "TOOL",
          toolName: "Task",
          kind: "task",
          subagent: { type: "code-reviewer", model: "sonnet" },
        }),
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
      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Working on it..." }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      // message.created + part.done + message.done
      expect(events).toHaveLength(3);
      const partEvt = events.find((e) => e.type === "part.done" || e.type === "part.created");
      const part = partFrom(partEvt!);
      expect(part).toMatchObject({
        type: "TEXT",
        text: "Working on it...",
        parentToolCallId: "task_1",
      });
    });
  });
});
