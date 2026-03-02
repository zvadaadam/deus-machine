import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ───────────────────────────────────────────────────────────

const { mockDbRun, mockDbGet, mockDbAll, mockDbPrepare } = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbGet = vi.fn();
  const mockDbAll = vi.fn().mockReturnValue([]);
  const mockDbPrepare = vi.fn(() => ({ run: mockDbRun, get: mockDbGet, all: mockDbAll }));
  return { mockDbRun, mockDbGet, mockDbAll, mockDbPrepare };
});

vi.mock("../db/index", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare }),
}));

import {
  saveAssistantMessage,
  saveToolResultMessage,
  updateSessionStatus,
  updateLastUserMessageAt,
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
  });

  // ── updateLastUserMessageAt ──────────────────────────────────────────

  describe("updateLastUserMessageAt", () => {
    it("returns ok:true on success", () => {
      const result = updateLastUserMessageAt("session-1");
      expect(result.ok).toBe(true);
    });

    it("returns ok:false on failure", () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_ERROR");
      });
      const result = updateLastUserMessageAt("session-1");
      expect(result.ok).toBe(false);
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
