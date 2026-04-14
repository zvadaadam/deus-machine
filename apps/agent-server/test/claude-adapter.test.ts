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
          messageId: "msg-1-1",
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
    it("detects Agent tool (real SDK name) and sets subagent metadata", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent_1",
              name: "Agent",
              input: {
                description: "Read file",
                subagent_type: "Explore",
                prompt: "Read shared/agent-events.ts",
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      expect(events).toHaveLength(3);
      const partEvt = events.find((e) => e.type === "part.created");
      expect(partEvt).toMatchObject({
        type: "part.created",
        part: expect.objectContaining({
          type: "TOOL",
          toolName: "Agent",
          kind: "task",
          subagent: expect.objectContaining({ type: "Explore" }),
        }),
      });
    });

    it("detects Agent tool via streaming path", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "agent_1", name: "Agent", input: {} },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });
      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"subagent_type":"dev","prompt":"do stuff"}',
          },
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

      const toolEvent = events.find((e) => e.type === "part.created" && e.part.type === "TOOL");
      expect(toolEvent).toBeDefined();
      expect(partFrom(toolEvent!)).toMatchObject({
        type: "TOOL",
        toolName: "Agent",
        kind: "task",
        subagent: { type: "dev" },
      });
    });

    it("updates tool part title from task_started system event", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Create Agent tool via assistant event
      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent_1",
              name: "Agent",
              input: { subagent_type: "Explore", prompt: "Read file" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Task started system event
      const events = transformer.process({
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "agent_1",
        description: "Reading shared/agent-events.ts",
        task_type: "local_agent",
        prompt: "Read file",
        session_id: "s_123",
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "part.created",
        part: expect.objectContaining({
          type: "TOOL",
          toolCallId: "agent_1",
          state: expect.objectContaining({
            status: "RUNNING",
            title: "Reading shared/agent-events.ts",
          }),
        }),
      });
    });

    it("updates tool part title from task_progress system event", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "agent_1", name: "Agent", input: { subagent_type: "dev" } },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const events = transformer.process({
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        tool_use_id: "agent_1",
        description: "Writing tests...",
        usage: { total_tokens: 5000, tool_uses: 3, duration_ms: 2000 },
        last_tool_name: "Write",
        session_id: "s_123",
      } as any);

      expect(events).toHaveLength(1);
      expect(partFrom(events[0]!)).toMatchObject({
        state: expect.objectContaining({
          title: "Writing tests...",
        }),
      });
    });

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
          subagent: expect.objectContaining({ type: "code-reviewer", model: "sonnet" }),
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

    it("emits untagged boundary part.done events when parent context changes", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Parent streaming text" },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Subagent output" }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      expect(events[0]).toMatchObject({
        type: "part.done",
        part: expect.objectContaining({
          type: "TEXT",
          text: "Parent streaming text",
          state: "DONE",
        }),
      });
      expect((events[0] as any).part.parentToolCallId).toBeUndefined();

      const subagentPart = events.find(
        (e) =>
          (e.type === "part.created" || e.type === "part.done") && e.part.text === "Subagent output"
      );
      expect(subagentPart).toMatchObject({
        part: expect.objectContaining({ parentToolCallId: "task_1" }),
      });
    });

    it("propagates parentToolCallId on message.created for subagent messages", () => {
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

      // Subagent produces text — message.created should carry parentToolCallId
      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Subagent output" }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      const msgCreated = events.find((e) => e.type === "message.created");
      expect(msgCreated).toMatchObject({
        type: "message.created",
        role: "assistant",
        parentToolCallId: "task_1",
      });
    });

    it("propagates parentToolCallId on message.done for subagent messages", () => {
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

      // Subagent produces text — message.done should carry parentToolCallId
      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Done working" }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      const msgDone = events.find((e) => e.type === "message.done");
      expect(msgDone).toMatchObject({
        type: "message.done",
        parentToolCallId: "task_1",
      });
    });

    it("does NOT set parentToolCallId on parent-level messages", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Parent message with no parent_tool_use_id
      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Parent text" }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      const msgCreated = events.find((e) => e.type === "message.created");
      expect(msgCreated).toMatchObject({ type: "message.created", role: "assistant" });
      expect((msgCreated as any).parentToolCallId).toBeUndefined();

      const msgDone = events.find((e) => e.type === "message.done");
      expect((msgDone as any).parentToolCallId).toBeUndefined();
    });

    it("handles streaming subagent events with parentToolCallId on messages", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Parent creates Task tool via streaming
      transformer.process({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_s1",
            role: "assistant",
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "task_1", name: "Task", input: {} },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });
      transformer.process({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"subagent_type":"dev"}' },
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });
      transformer.process({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
        session_id: "s_123",
      });
      transformer.process({
        type: "stream_event",
        event: { type: "message_stop" },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Now subagent starts streaming with parent_tool_use_id set
      const subagentEvents = transformer.process({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_s2",
            role: "assistant",
            content: [],
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      // message.created should carry parentToolCallId
      const msgCreated = subagentEvents.find((e) => e.type === "message.created");
      expect(msgCreated).toMatchObject({
        type: "message.created",
        parentToolCallId: "task_1",
      });
    });

    it("suppresses turn.completed for active subagents", () => {
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

      // Subagent result event — should NOT emit turn.completed
      const resultEvents = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const turnCompleted = resultEvents.find((e) => e.type === "turn.completed");
      expect(turnCompleted).toBeUndefined();
    });

    it("emits turn.completed after subagent tool result completes", () => {
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

      // First result — subagent finished internally
      transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      // Tool result arrives — unregisters subagent
      transformer.process({
        type: "user",
        message: {
          id: "msg_3",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task_1", content: "Subagent done" }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Final result — now turn.completed should fire
      const finalEvents = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 200, output_tokens: 100 },
        total_cost_usd: 0.01,
      });

      const turnCompleted = finalEvents.find((e) => e.type === "turn.completed");
      expect(turnCompleted).toBeDefined();
      expect(turnCompleted).toMatchObject({
        type: "turn.completed",
        finishReason: "end_turn",
      });
    });

    it("handles multiple subagents in parallel", () => {
      const transformer = claudeCodeAdapter.createTransformer(makeCtx());

      // Parent creates two Task tools
      transformer.process({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task_1", name: "Task", input: { subagent_type: "dev" } },
            { type: "tool_use", id: "task_2", name: "Task", input: { subagent_type: "reviewer" } },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Result while 2 subagents active — should NOT emit turn.completed
      const events1 = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      expect(events1.find((e) => e.type === "turn.completed")).toBeUndefined();

      // First subagent tool result arrives
      transformer.process({
        type: "user",
        message: {
          id: "msg_2",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task_1", content: "Done 1" }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Result with 1 subagent still active — still should NOT emit turn.completed
      const events2 = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 150, output_tokens: 75 },
      });
      expect(events2.find((e) => e.type === "turn.completed")).toBeUndefined();

      // Second subagent tool result
      transformer.process({
        type: "user",
        message: {
          id: "msg_3",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task_2", content: "Done 2" }],
        },
        parent_tool_use_id: null,
        session_id: "s_123",
      });

      // Final result — all subagents done, should emit turn.completed
      const events3 = transformer.process({
        type: "result",
        subtype: "success",
        session_id: "s_123",
        usage: { input_tokens: 200, output_tokens: 100 },
        total_cost_usd: 0.02,
      });
      expect(events3.find((e) => e.type === "turn.completed")).toBeDefined();
    });

    it("subagent text and tool parts within same message get tagged", () => {
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

      // Subagent produces mixed content
      const events = transformer.process({
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Subagent thinking..." },
            { type: "text", text: "Let me read the file" },
            { type: "tool_use", id: "tool_inner", name: "Read", input: { path: "/foo" } },
          ],
        },
        parent_tool_use_id: "task_1",
        session_id: "s_123",
      });

      // All parts should have parentToolCallId
      const partEvents = events.filter((e) => e.type === "part.created" || e.type === "part.done");
      expect(partEvents.length).toBeGreaterThanOrEqual(3);
      for (const pe of partEvents) {
        const part = partFrom(pe);
        expect(part?.parentToolCallId).toBe("task_1");
      }
    });
  });
});
