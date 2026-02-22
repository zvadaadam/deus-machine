import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ───────────────────────────────────────────────────────────

const { mockDbRun, mockDbGet, mockDbPrepare, mockPrepareMessageContent } = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbGet = vi.fn();
  const mockDbPrepare = vi.fn(() => ({ run: mockDbRun, get: mockDbGet }));
  const mockPrepareMessageContent = vi.fn((envelope: unknown) => ({
    success: true,
    content: JSON.stringify(envelope),
  }));
  return { mockDbRun, mockDbGet, mockDbPrepare, mockPrepareMessageContent };
});

vi.mock("../db/index", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare }),
}));

vi.mock("../db/message-sanitizer", () => ({
  prepareMessageContent: mockPrepareMessageContent,
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

    it("returns ok:false when content preparation fails", () => {
      mockPrepareMessageContent.mockReturnValueOnce({ success: false, error: "invalid JSON" });

      const result = saveAssistantMessage("session-1", { id: "msg-1", content: "hello" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Content preparation failed");
      }
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
        throw new Error("SQLITE_READONLY");
      });
      const result = saveToolResultMessage("session-1", { id: "msg-1", content: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_READONLY");
      }
    });
  });

  // ── updateSessionStatus ──────────────────────────────────────────────

  describe("updateSessionStatus", () => {
    it("returns ok:true on success", () => {
      const result = updateSessionStatus("session-1", "idle");
      expect(result.ok).toBe(true);
    });

    it("returns ok:false on persistent failure", () => {
      mockDbRun.mockImplementation(() => {
        throw new Error("SQLITE_CORRUPT");
      });
      const result = updateSessionStatus("session-1", "error", "something broke");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SQLITE_CORRUPT");
      }
      mockDbRun.mockReset();
    });

    it("retries once on SQLITE_BUSY then succeeds", () => {
      let callCount = 0;
      mockDbRun.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        // Second call succeeds
      });

      const result = updateSessionStatus("session-1", "idle");
      expect(result.ok).toBe(true);
      expect(callCount).toBe(2);
      mockDbRun.mockReset();
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
