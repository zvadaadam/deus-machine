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
  persistMessageCancelled,
  persistPartDone,
  persistMessageDone,
  persistSessionStarted,
  persistSessionIdle,
  persistSessionError,
  persistSessionCancelled,
  persistAgentSessionId,
  persistSessionTitle,
} from "../../../src/services/agent/persistence";
import type {
  MessageCancelledEvent,
  PartDoneEvent,
  MessageDoneEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionErrorEvent,
  SessionCancelledEvent,
  AgentSessionIdEvent,
  SessionTitleEvent,
} from "../../../../shared/agent-events";

// ============================================================================
// Tests
// ============================================================================

describe("agent-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReturnValue({ changes: 1 });
    mockPrepare.mockReturnValue({ run: mockRun });
    mockTransaction.mockImplementation((fn: () => void) => fn);
  });

  // ==========================================================================
  // Message writes
  // ==========================================================================

  describe("persistMessageCancelled", () => {
    const event: MessageCancelledEvent = {
      type: "message.cancelled",
      sessionId: "sess-1",
      agentHarness: "claude",
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

  describe("persistPartDone", () => {
    const textEvent: PartDoneEvent = {
      type: "part.done",
      sessionId: "sess-1",
      agentHarness: "claude",
      messageId: "msg-1",
      partId: "p1",
      part: {
        type: "TEXT",
        id: "p1",
        sessionId: "sess-1",
        messageId: "msg-1",
        text: "Hello!",
      },
    };

    it("inserts a part row with correct parameters", () => {
      const result = persistPartDone(textEvent);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("p1");
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT OR REPLACE INTO parts")
      );
      expect(mockRun).toHaveBeenCalledWith(
        "p1", // id
        "msg-1", // message_id
        "sess-1", // session_id
        0, // seq
        "TEXT", // type
        expect.any(String), // data (JSON)
        null, // tool_call_id (not a TOOL part)
        null, // tool_name (not a TOOL part)
        null // parent_tool_call_id
      );
    });

    it("stores the full part as JSON in data column", () => {
      persistPartDone(textEvent);

      const dataArg = mockRun.mock.calls[0][5] as string;
      const parsed = JSON.parse(dataArg);
      expect(parsed.type).toBe("TEXT");
      expect(parsed.text).toBe("Hello!");
      expect(parsed.id).toBe("p1");
    });

    it("extracts toolCallId and toolName for TOOL parts", () => {
      const toolEvent: PartDoneEvent = {
        type: "part.done",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-1",
        partId: "p2",
        part: {
          type: "TOOL",
          id: "p2",
          sessionId: "sess-1",
          messageId: "msg-1",
          toolCallId: "tc-1",
          toolName: "bash",
          state: {
            status: "COMPLETED",
            input: "ls",
            output: "file.ts",
            time: { start: "t0", end: "t1" },
          },
        },
      };

      persistPartDone(toolEvent);

      expect(mockRun).toHaveBeenCalledWith(
        "p2", // id
        "msg-1", // message_id
        "sess-1", // session_id
        0, // seq
        "TOOL", // type
        expect.any(String), // data
        "tc-1", // tool_call_id
        "bash", // tool_name
        null // parent_tool_call_id
      );
    });

    it("stores parentToolCallId when present", () => {
      const nestedEvent: PartDoneEvent = {
        type: "part.done",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-1",
        partId: "p3",
        part: {
          type: "TEXT",
          id: "p3",
          sessionId: "sess-1",
          messageId: "msg-1",
          text: "nested text",
          parentToolCallId: "tc-parent",
        },
      };

      persistPartDone(nestedEvent);

      // parent_tool_call_id is the last argument
      expect(mockRun).toHaveBeenCalledWith(
        "p3",
        "msg-1",
        "sess-1",
        0,
        "TEXT",
        expect.any(String),
        null,
        null,
        "tc-parent"
      );
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB locked");
        }),
      });

      const result = persistPartDone(textEvent);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("DB locked");
    });
  });

  describe("persistMessageDone", () => {
    const event: MessageDoneEvent = {
      type: "message.done",
      sessionId: "sess-1",
      agentHarness: "claude",
      messageId: "msg-1",
      stopReason: "end_turn",
      parts: [],
    };

    it("updates stop_reason on the message row", () => {
      const result = persistMessageDone(event);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("msg-1");
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE messages SET stop_reason")
      );
      expect(mockRun).toHaveBeenCalledWith("end_turn", "msg-1");
    });

    it("matches on id column", () => {
      persistMessageDone(event);

      const sql = mockPrepare.mock.calls[0][0] as string;
      expect(sql).toContain("WHERE id =");
    });

    it("stores null when stopReason is absent", () => {
      const noReasonEvent: MessageDoneEvent = {
        type: "message.done",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-2",
        parts: [],
      };

      persistMessageDone(noReasonEvent);

      expect(mockRun).toHaveBeenCalledWith(null, "msg-2");
    });

    it("returns error on DB failure", () => {
      mockPrepare.mockReturnValue({
        run: vi.fn(() => {
          throw new Error("DB locked");
        }),
      });

      const result = persistMessageDone(event);

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
      agentHarness: "claude",
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
        agentHarness: "claude",
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
        agentHarness: "claude",
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
        agentHarness: "claude",
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
      agentHarness: "claude",
      title: "Fix login page CSS",
    };

    it("updates session title only", () => {
      const result = persistSessionTitle(event);

      expect(result.ok).toBe(true);
      expect(mockPrepare).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("UPDATE sessions SET title")
      );
      expect(mockRun).toHaveBeenNthCalledWith(1, "Fix login page CSS", "sess-1");
      expect(mockPrepare).toHaveBeenCalledTimes(1);
    });

    it("ignores unusable SDK fallback titles", () => {
      const result = persistSessionTitle({ ...event, title: "(session)" });

      expect(result.ok).toBe(true);
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("returns error on DB failure", () => {
      mockRun.mockImplementation(() => {
        throw new Error("transaction failed");
      });

      const result = persistSessionTitle(event);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("transaction failed");
    });
  });
});
