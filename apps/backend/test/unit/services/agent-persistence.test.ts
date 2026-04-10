import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ============================================================================

const { mockRun, mockPrepare, mockTransaction, mockDb } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ changes: 1 }));
  const mockPrepare = vi.fn(() => ({ run: mockRun }));
  const mockTransaction = vi.fn((fn: () => void) => fn);
  const mockDb = {
    prepare: mockPrepare,
    transaction: mockTransaction,
  };
  return { mockRun, mockPrepare, mockTransaction, mockDb };
});

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

// ============================================================================
// Import after mocks
// ============================================================================

import {
  persistAssistantMessage,
  persistToolResultMessage,
  persistMessageResult,
  persistMessageCancelled,
  persistMessagePartsFinished,
  persistSessionStarted,
  persistSessionIdle,
  persistSessionError,
  persistSessionCancelled,
  persistAgentSessionId,
  persistSessionTitle,
} from "../../../src/services/agent/persistence";
import type {
  MessageAssistantEvent,
  MessageToolResultEvent,
  MessageResultEvent,
  MessageCancelledEvent,
  MessagePartsFinishedEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionErrorEvent,
  SessionCancelledEvent,
  AgentSessionIdEvent,
  SessionTitleEvent,
} from "../../../../shared/agent-events";
import type { Part } from "../../../../shared/messages";

// ============================================================================
// Tests
// ============================================================================

describe("agent-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue({ run: mockRun });
    mockTransaction.mockImplementation((fn: () => void) => fn);
  });

  // ==========================================================================
  // Message writes
  // ==========================================================================

  describe("persistAssistantMessage", () => {
    const baseEvent: MessageAssistantEvent = {
      type: "message.assistant",
      sessionId: "sess-1",
      agentType: "claude",
      message: {
        id: "msg-sdk-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
      model: "opus",
    };

    it("inserts an assistant message with correct parameters", () => {
      const result = persistAssistantMessage(baseEvent);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(expect.any(String)); // UUID7 message ID
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"));
      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String), // messageId
        "sess-1", // sessionId
        expect.any(String), // content JSON
        expect.any(String), // sentAt
        "opus", // model
        "msg-sdk-1", // agent_message_id
        null // parent_tool_use_id
      );
    });

    it("stores flat content for normal messages", () => {
      persistAssistantMessage(baseEvent);

      const contentArg = mockRun.mock.calls[0][2] as string;
      const parsed = JSON.parse(contentArg);
      expect(parsed).toEqual([{ type: "text", text: "Hello!" }]);
    });

    it("stores envelope format for cancelled messages", () => {
      const cancelledEvent: MessageAssistantEvent = {
        ...baseEvent,
        message: {
          ...baseEvent.message,
          stop_reason: "cancelled",
        },
      };

      persistAssistantMessage(cancelledEvent);

      const contentArg = mockRun.mock.calls[0][2] as string;
      const parsed = JSON.parse(contentArg);
      expect(parsed).toEqual({
        message: { stop_reason: "cancelled" },
        blocks: [{ type: "text", text: "Hello!" }],
      });
    });

    it("handles parent_tool_use_id", () => {
      const eventWithParent: MessageAssistantEvent = {
        ...baseEvent,
        message: {
          ...baseEvent.message,
          parent_tool_use_id: "tool-use-123",
        },
      };

      persistAssistantMessage(eventWithParent);

      // parent_tool_use_id is the last argument
      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String),
        "sess-1",
        expect.any(String),
        expect.any(String),
        "opus",
        "msg-sdk-1",
        "tool-use-123"
      );
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB locked");
        }),
      });

      const result = persistAssistantMessage(baseEvent);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("DB locked");
    });
  });

  describe("persistToolResultMessage", () => {
    const baseEvent: MessageToolResultEvent = {
      type: "message.tool_result",
      sessionId: "sess-1",
      agentType: "claude",
      message: {
        id: "msg-sdk-2",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "output" }],
        parent_tool_use_id: "tu-1",
      },
    };

    it("inserts a tool_result message with role=user", () => {
      const result = persistToolResultMessage(baseEvent);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"));
      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String), // messageId
        "sess-1", // sessionId
        expect.any(String), // content JSON
        expect.any(String), // sentAt
        "msg-sdk-2", // agent_message_id
        "tu-1" // parent_tool_use_id
      );
    });

    it("stores content blocks directly (no envelope)", () => {
      persistToolResultMessage(baseEvent);

      const contentArg = mockRun.mock.calls[0][2] as string;
      const parsed = JSON.parse(contentArg);
      expect(parsed).toEqual([{ type: "tool_result", tool_use_id: "tu-1", content: "output" }]);
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("constraint violation");
        }),
      });

      const result = persistToolResultMessage(baseEvent);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("constraint violation");
    });
  });

  describe("persistMessageResult", () => {
    it("is a no-op (informational only)", () => {
      const event: MessageResultEvent = {
        type: "message.result",
        sessionId: "sess-1",
        agentType: "claude",
        subtype: "success",
      };

      // Should not throw and not call DB
      persistMessageResult(event);

      expect(mockPrepare).not.toHaveBeenCalled();
    });
  });

  describe("persistMessageCancelled", () => {
    const event: MessageCancelledEvent = {
      type: "message.cancelled",
      sessionId: "sess-1",
      agentType: "claude",
    };

    it("inserts a cancelled message marker and sets session to idle", () => {
      const result = persistMessageCancelled(event);

      expect(result.ok).toBe(true);
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      // First prepare: INSERT message
      expect(mockPrepare).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("INSERT INTO messages")
      );

      // Second prepare: UPDATE session status to idle
      expect(mockPrepare).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("UPDATE sessions SET status = 'idle'")
      );
    });

    it("inserts cancelled envelope content", () => {
      persistMessageCancelled(event);

      const contentArg = mockRun.mock.calls[0][2] as string;
      const parsed = JSON.parse(contentArg);
      expect(parsed).toEqual({
        message: { stop_reason: "cancelled" },
        blocks: [],
      });
    });

    it("returns error on DB failure", () => {
      mockTransaction.mockImplementation(() => {
        throw new Error("transaction failed");
      });

      const result = persistMessageCancelled(event);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("transaction failed");
    });
  });

  describe("persistMessagePartsFinished", () => {
    const baseEvent: MessagePartsFinishedEvent = {
      type: "message.parts_finished",
      sessionId: "sess-1",
      agentType: "claude",
      messageId: "msg-parts-1",
      usage: { input: 100, output: 50 },
      finishReason: "end_turn",
      cost: 0.003,
    };

    const parts: Part[] = [
      { type: "TEXT", id: "p1", sessionId: "sess-1", messageId: "msg-parts-1", text: "Hello!" },
      {
        type: "TOOL",
        id: "p2",
        sessionId: "sess-1",
        messageId: "msg-parts-1",
        toolCallId: "tc-1",
        toolName: "bash",
        state: {
          status: "COMPLETED",
          input: "ls",
          output: "file.ts",
          time: { start: "t0", end: "t1" },
        },
      },
    ];

    it("updates the most recent assistant message with parts JSON", () => {
      const result = persistMessagePartsFinished(baseEvent, parts);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE messages SET parts")
      );

      const partsArg = mockRun.mock.calls[0][0] as string;
      const parsed = JSON.parse(partsArg);
      expect(parsed.parts).toHaveLength(2);
      expect(parsed.parts[0].type).toBe("TEXT");
      expect(parsed.parts[1].type).toBe("TOOL");
      expect(parsed.usage).toEqual({ input: 100, output: 50 });
      expect(parsed.finishReason).toBe("end_turn");
      expect(parsed.cost).toBe(0.003);
    });

    it("queries by session_id and role='assistant' ordered by seq DESC", () => {
      persistMessagePartsFinished(baseEvent, parts);

      const sql = mockPrepare.mock.calls[0][0] as string;
      expect(sql).toContain("session_id = ?");
      expect(sql).toContain("role = 'assistant'");
      expect(sql).toContain("ORDER BY seq DESC LIMIT 1");
    });

    it("passes sessionId as the WHERE parameter", () => {
      persistMessagePartsFinished(baseEvent, parts);

      expect(mockRun).toHaveBeenCalledWith(expect.any(String), "sess-1");
    });

    it("stores null for optional fields when absent", () => {
      const minimalEvent: MessagePartsFinishedEvent = {
        type: "message.parts_finished",
        sessionId: "sess-1",
        agentType: "claude",
        messageId: "msg-parts-2",
        usage: { input: 0, output: 0 },
      };

      persistMessagePartsFinished(minimalEvent, []);

      const partsArg = mockRun.mock.calls[0][0] as string;
      const parsed = JSON.parse(partsArg);
      expect(parsed.finishReason).toBeNull();
      expect(parsed.cost).toBeNull();
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB locked");
        }),
      });

      const result = persistMessagePartsFinished(baseEvent, parts);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("DB locked");
    });
  });

  // ==========================================================================
  // Session status writes
  // ==========================================================================

  describe("persistSessionStarted", () => {
    const event: SessionStartedEvent = {
      type: "session.started",
      sessionId: "sess-1",
      agentType: "claude",
    };

    it("updates session to working status (idempotent)", () => {
      const result = persistSessionStarted(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status = 'working'"));
      // Should include idempotency guard
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status != 'working'"));
      expect(mockRun).toHaveBeenCalledWith("sess-1");
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB error");
        }),
      });

      const result = persistSessionStarted(event);

      expect(result.ok).toBe(false);
    });
  });

  describe("persistSessionIdle", () => {
    it("updates session to idle status", () => {
      const event: SessionIdleEvent = {
        type: "session.idle",
        sessionId: "sess-1",
        agentType: "claude",
      };

      const result = persistSessionIdle(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status = 'idle'"));
      expect(mockRun).toHaveBeenCalledWith("sess-1");
    });
  });

  describe("persistSessionError", () => {
    it("updates session to error status with error details", () => {
      const event: SessionErrorEvent = {
        type: "session.error",
        sessionId: "sess-1",
        agentType: "claude",
        error: "Rate limit exceeded",
        category: "rate_limit",
      };

      const result = persistSessionError(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status = 'error'"));
      expect(mockRun).toHaveBeenCalledWith("Rate limit exceeded", "rate_limit", "sess-1");
    });
  });

  describe("persistSessionCancelled", () => {
    it("updates session to idle status (cancelled = back to idle)", () => {
      const event: SessionCancelledEvent = {
        type: "session.cancelled",
        sessionId: "sess-1",
        agentType: "claude",
      };

      const result = persistSessionCancelled(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status = 'idle'"));
      expect(mockRun).toHaveBeenCalledWith("sess-1");
    });
  });

  // ==========================================================================
  // Metadata writes
  // ==========================================================================

  describe("persistAgentSessionId", () => {
    it("stores the agent session ID for resume support", () => {
      const event: AgentSessionIdEvent = {
        type: "agent.session_id",
        sessionId: "sess-1",
        agentSessionId: "claude-sdk-session-abc",
      };

      const result = persistAgentSessionId(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("agent_session_id"));
      expect(mockRun).toHaveBeenCalledWith("claude-sdk-session-abc", "sess-1");
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB error");
        }),
      });

      const event: AgentSessionIdEvent = {
        type: "agent.session_id",
        sessionId: "sess-1",
        agentSessionId: "abc",
      };

      const result = persistAgentSessionId(event);

      expect(result.ok).toBe(false);
    });
  });

  describe("persistSessionTitle", () => {
    const event: SessionTitleEvent = {
      type: "session.title",
      sessionId: "sess-1",
      agentType: "claude",
      title: "Fix login page CSS",
    };

    it("updates session title and workspace title in a transaction", () => {
      const result = persistSessionTitle(event);

      expect(result.ok).toBe(true);
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      // First prepare: UPDATE sessions SET title
      expect(mockPrepare).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("UPDATE sessions SET title")
      );
      expect(mockRun).toHaveBeenNthCalledWith(1, "Fix login page CSS", "sess-1");

      // Second prepare: UPDATE workspaces SET title ... AND title IS NULL
      expect(mockPrepare).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("UPDATE workspaces SET title")
      );
      expect(mockRun).toHaveBeenNthCalledWith(2, "Fix login page CSS", "sess-1");
    });

    it("only sets workspace title when it is NULL (preserves user renames)", () => {
      persistSessionTitle(event);

      // The second SQL statement should include AND title IS NULL
      expect(mockPrepare).toHaveBeenNthCalledWith(2, expect.stringContaining("AND title IS NULL"));
    });

    it("returns error on DB failure", () => {
      mockTransaction.mockImplementation(() => {
        throw new Error("transaction failed");
      });

      const result = persistSessionTitle(event);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("transaction failed");
    });
  });
});
