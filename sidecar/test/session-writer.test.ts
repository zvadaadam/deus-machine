import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ───────────────────────────────────────────────────────────

const { mockDbRun, mockDbGet, mockDbAll, mockDbPrepare, mockTransaction, mockSendStatusChanged } = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbGet = vi.fn();
  const mockDbAll = vi.fn().mockReturnValue([]);
  const mockDbPrepare = vi.fn(() => ({ run: mockDbRun, get: mockDbGet, all: mockDbAll }));
  // db.transaction(fn) returns a wrapped function that executes fn inside a transaction
  const mockTransaction = vi.fn((fn: () => void) => {
    const wrapped = () => fn();
    return wrapped;
  });
  const mockSendStatusChanged = vi.fn();
  return { mockDbRun, mockDbGet, mockDbAll, mockDbPrepare, mockTransaction, mockSendStatusChanged };
});

vi.mock("../db/index", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare, transaction: mockTransaction }),
}));

vi.mock("../frontend-client", () => ({
  FrontendClient: { sendStatusChanged: mockSendStatusChanged },
}));

import {
  saveAssistantMessage,
  saveToolResultMessage,
  saveUserMessage,
  updateSessionStatus,
  saveAgentSessionId,
  lookupAgentSessionId,
  reconcileStuckSessions,
  type WriteResult,
} from "../db/session-writer";

// ── Tests ────────────────────────────────────────────────────────────────

describe("session-writer WriteResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── saveAssistantMessage ─────────────────────────────────────────────

  describe("saveAssistantMessage", () => {
    it("returns ok:true with messageId on success", () => {
      const result = saveAssistantMessage("session-1", { id: "msg-1", content: "hello" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it("returns ok:false when DB throws", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const result = saveAssistantMessage("session-1", { id: "msg-1", content: "hello" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_BUSY");
      }
    });

    it("wraps content in envelope when stop_reason is cancelled", () => {
      const result = saveAssistantMessage("session-1", {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stop_reason: "cancelled",
      });
      expect(result.ok).toBe(true);

      // Cancelled messages keep the envelope so the frontend can detect
      // cancellation from DB content (the "Turn interrupted" label).
      const storedContent = mockDbRun.mock.calls[0][2]; // 3rd arg = content
      const parsed = JSON.parse(storedContent);
      expect(parsed.message.stop_reason).toBe("cancelled");
      expect(parsed.blocks).toEqual([{ type: "text", text: "" }]);
    });

    it("stores content as flat array when no stop_reason", () => {
      const blocks = [{ type: "text", text: "hello" }];
      saveAssistantMessage("session-1", { content: blocks });

      const storedContent = mockDbRun.mock.calls[0][2];
      const parsed = JSON.parse(storedContent);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual(blocks);
    });
  });

  // ── saveToolResultMessage ────────────────────────────────────────────

  describe("saveToolResultMessage", () => {
    it("returns ok:true with messageId on success", () => {
      const result = saveToolResultMessage("session-1", { id: "msg-1", content: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
      }
    });

    it("returns ok:false when DB throws", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_ERROR");
      });
      const result = saveToolResultMessage("session-1", { id: "msg-1", content: [] });
      expect(result.ok).toBe(false);
    });
  });

  // ── saveUserMessage ─────────────────────────────────────────────────

  describe("saveUserMessage", () => {
    it("returns ok:true with messageId on success", () => {
      const result = saveUserMessage("session-1", "Fix the login bug");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it("uses a transaction to wrap INSERT + UPDATE atomically", () => {
      saveUserMessage("session-1", "Hello");
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it("inserts user message with correct role and columns", () => {
      saveUserMessage("session-1", "Fix the bug", "sonnet");
      // Transaction calls prepare twice inside the fn: INSERT then UPDATE
      const prepareCalls = mockDbPrepare.mock.calls as string[][];
      const insertCall = prepareCalls.find((args) => args[0]?.includes("INSERT INTO messages"));
      expect(insertCall).toBeDefined();
      expect(insertCall![0]).toContain("'user'");
    });

    it("updates session status to working and sets last_user_message_at", () => {
      saveUserMessage("session-1", "Fix the bug");
      const prepareCalls = mockDbPrepare.mock.calls as string[][];
      const updateCall = prepareCalls.find((args) => args[0]?.includes("UPDATE sessions SET status"));
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain("'working'");
      expect(updateCall![0]).toContain("last_user_message_at");
    });

    it("clears error_message and error_category in the session UPDATE", () => {
      saveUserMessage("session-1", "Retry the task");
      const prepareCalls = mockDbPrepare.mock.calls as string[][];
      const updateCall = prepareCalls.find((args) => args[0]?.includes("UPDATE sessions SET status"));
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain("error_message = NULL");
      expect(updateCall![0]).toContain("error_category = NULL");
    });

    it("uses default model 'opus' when no model provided", () => {
      saveUserMessage("session-1", "Hello");
      // Find the INSERT run call — it gets the model as 5th arg
      const runCalls = mockDbRun.mock.calls as unknown[][];
      // The INSERT run has 5 positional args: messageId, sessionId, content, sentAt, model
      const insertRun = runCalls.find((args) => args.length === 5);
      expect(insertRun).toBeDefined();
      expect(insertRun![4]).toBe("opus");
    });

    it("returns ok:false when transaction throws", () => {
      mockTransaction.mockImplementationOnce(() => {
        return () => { throw new Error("SQLITE_BUSY: database is locked"); };
      });
      const result = saveUserMessage("session-1", "Hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_BUSY");
      }
    });

    it("does not persist anything when transaction fails (atomicity)", () => {
      mockTransaction.mockImplementationOnce(() => {
        return () => { throw new Error("SQLITE_CONSTRAINT"); };
      });
      const result = saveUserMessage("session-1", "Hello");
      expect(result.ok).toBe(false);
      // Transaction wrapper throws before body executes — no DB writes should leak
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("emits sendStatusChanged with status='working' after transaction", () => {
      saveUserMessage("session-1", "Fix the bug");
      expect(mockSendStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status_changed",
          id: "session-1",
          status: "working",
        })
      );
    });

    it("does not emit sendStatusChanged when transaction fails", () => {
      mockTransaction.mockImplementationOnce(() => {
        return () => { throw new Error("SQLITE_BUSY"); };
      });
      saveUserMessage("session-1", "Hello");
      expect(mockSendStatusChanged).not.toHaveBeenCalled();
    });
  });

  // ── updateSessionStatus ──────────────────────────────────────────────

  describe("updateSessionStatus", () => {
    it("returns ok:true on success", () => {
      const result = updateSessionStatus("session-1", "idle");
      expect(result.ok).toBe(true);
    });

    it("returns ok:false on failure", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_ERROR");
      });
      const result = updateSessionStatus("session-1", "error", "fail");
      expect(result.ok).toBe(false);
    });

    it("retries once on SQLITE_BUSY then fails", () => {
      mockDbRun.mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });

      const result = updateSessionStatus("session-1", "idle");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_BUSY");
      }
      // Should have been called exactly 2 times (initial + 1 retry)
      expect(mockDbRun).toHaveBeenCalledTimes(2);
      mockDbRun.mockReset();
    });

    it("passes error message and category when status is error", () => {
      updateSessionStatus("session-1", "error", "Something went wrong", "auth");
      expect(mockDbRun).toHaveBeenCalledWith("error", "Something went wrong", "auth", "session-1");
    });

    it("clears error message and category when status is idle", () => {
      updateSessionStatus("session-1", "idle");
      expect(mockDbRun).toHaveBeenCalledWith("idle", null, null, "session-1");
    });

    it("calls sendStatusChanged with correct payload on success", () => {
      updateSessionStatus("session-1", "idle");
      expect(mockSendStatusChanged).toHaveBeenCalledWith({
        type: "status_changed",
        id: "session-1",
        agentType: "claude",
        status: "idle",
      });
    });

    it("calls sendStatusChanged with error details when status is error", () => {
      updateSessionStatus("session-1", "error", "API key invalid", "auth");
      expect(mockSendStatusChanged).toHaveBeenCalledWith({
        type: "status_changed",
        id: "session-1",
        agentType: "claude",
        status: "error",
        errorMessage: "API key invalid",
        errorCategory: "auth",
      });
    });

    it("does not break when sendStatusChanged throws", () => {
      mockSendStatusChanged.mockImplementationOnce(() => {
        throw new Error("No tunnel attached");
      });
      const result = updateSessionStatus("session-1", "idle");
      expect(result.ok).toBe(true);
    });
  });

  // ── saveAgentSessionId ─────────────────────────────────────────────

  describe("saveAgentSessionId", () => {
    it("returns ok:true on success", () => {
      const result = saveAgentSessionId("session-1", "sdk-abc-123");
      expect(result.ok).toBe(true);
    });

    it("passes correct SQL params", () => {
      saveAgentSessionId("session-1", "sdk-abc-123");
      expect(mockDbPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET agent_session_id")
      );
      expect(mockDbRun).toHaveBeenCalledWith("sdk-abc-123", "session-1");
    });

    it("returns ok:false when DB throws", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_ERROR");
      });
      const result = saveAgentSessionId("session-1", "sdk-abc-123");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_ERROR");
      }
    });

    it("accepts null to clear a stale agent_session_id", () => {
      const result = saveAgentSessionId("session-1", null);
      expect(result.ok).toBe(true);
      expect(mockDbRun).toHaveBeenCalledWith(null, "session-1");
    });
  });

  // ── lookupAgentSessionId ───────────────────────────────────────────

  describe("lookupAgentSessionId", () => {
    it("returns agent_session_id when present", () => {
      mockDbGet.mockReturnValueOnce({ agent_session_id: "sdk-abc-123" });
      const result = lookupAgentSessionId("session-1");
      expect(result).toBe("sdk-abc-123");
    });

    it("returns null when no agent_session_id is set", () => {
      mockDbGet.mockReturnValueOnce({ agent_session_id: null });
      const result = lookupAgentSessionId("session-1");
      expect(result).toBeNull();
    });

    it("returns null when session does not exist", () => {
      mockDbGet.mockReturnValueOnce(undefined);
      const result = lookupAgentSessionId("session-1");
      expect(result).toBeNull();
    });

    it("returns null on DB error", () => {
      mockDbGet.mockImplementationOnce(() => {
        throw new Error("SQLITE_ERROR");
      });
      const result = lookupAgentSessionId("session-1");
      expect(result).toBeNull();
    });
  });

  // ── reconcileStuckSessions ─────────────────────────────────────────

  describe("reconcileStuckSessions", () => {
    it("returns ok:true with count of affected rows", () => {
      mockDbRun.mockReturnValueOnce({ changes: 3 });
      const result = reconcileStuckSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3);
      }
    });

    it("executes UPDATE on sessions with status working", () => {
      mockDbRun.mockReturnValueOnce({ changes: 0 });
      reconcileStuckSessions();
      expect(mockDbPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET status = 'idle'")
      );
      expect(mockDbPrepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status = 'working'")
      );
    });

    it("returns ok:true with 0 when no sessions are stuck", () => {
      mockDbRun.mockReturnValueOnce({ changes: 0 });
      const result = reconcileStuckSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("returns ok:false when DB throws", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });
      const result = reconcileStuckSessions();
      expect(result.ok).toBe(false);
    });
  });
});
