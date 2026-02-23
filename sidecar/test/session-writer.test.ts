import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ───────────────────────────────────────────────────────────

const { mockDbRun, mockDbGet, mockDbPrepare } = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbGet = vi.fn();
  const mockDbPrepare = vi.fn(() => ({ run: mockDbRun, get: mockDbGet }));
  return { mockDbRun, mockDbGet, mockDbPrepare };
});

vi.mock("../db/index", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare }),
}));

import {
  saveAssistantMessage,
  saveToolResultMessage,
  updateSessionStatus,
  updateLastUserMessageAt,
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

    it("wraps content in envelope when stop_reason is present", () => {
      const result = saveAssistantMessage("session-1", {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stop_reason: "cancelled",
      });
      expect(result.ok).toBe(true);

      // Verify the serialized content includes the envelope with stop_reason
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
});
