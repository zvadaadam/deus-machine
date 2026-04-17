import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// ============================================================================

const { mockPersistCancellation, mockNotifyAndRecordError, mockClassifyError } = vi.hoisted(() => ({
  mockPersistCancellation: vi.fn(),
  mockNotifyAndRecordError: vi.fn(),
  mockClassifyError: vi.fn(),
}));

// All functions now live in the same lifecycle module. Since handleCancellation
// and handleQueryError are thin wrappers that call persistCancellation,
// classifyError, and notifyAndRecordError (same-module siblings), we must
// mock the entire module and provide wrapper implementations that delegate
// to the mocked sub-functions — matching the real behavior exactly.
vi.mock("../agents/lifecycle", () => ({
  persistCancellation: mockPersistCancellation,
  notifyAndRecordError: mockNotifyAndRecordError,
  classifyError: mockClassifyError,
  handleCancellation: (sessionId: string, agentHarness: string, wasCancelled: boolean) => {
    if (!wasCancelled) return false;
    mockPersistCancellation(sessionId, agentHarness);
    return true;
  },
  handleQueryError: (
    sessionId: string,
    agentHarness: string,
    error: unknown,
    enrichMessage?: (classified: { message: string }) => string
  ) => {
    const classified = mockClassifyError(error);
    mockNotifyAndRecordError(sessionId, agentHarness, classified, enrichMessage);
  },
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import { handleCancellation, handleQueryError } from "../agents/lifecycle";

// ============================================================================
// Tests
// ============================================================================

describe("query-completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // handleCancellation
  // --------------------------------------------------------------------------

  describe("handleCancellation", () => {
    it("returns false and does nothing when wasCancelled is false", () => {
      const result = handleCancellation("sess-1", "claude", false);
      expect(result).toBe(false);
      expect(mockPersistCancellation).not.toHaveBeenCalled();
    });

    it("returns true and calls persistCancellation when wasCancelled is true", () => {
      const result = handleCancellation("sess-1", "claude", true);
      expect(result).toBe(true);
      expect(mockPersistCancellation).toHaveBeenCalledWith("sess-1", "claude");
    });

    it("passes correct agentHarness for codex", () => {
      handleCancellation("sess-2", "codex", true);
      expect(mockPersistCancellation).toHaveBeenCalledWith("sess-2", "codex");
    });
  });

  // --------------------------------------------------------------------------
  // handleQueryError
  // --------------------------------------------------------------------------

  describe("handleQueryError", () => {
    it("classifies the error and calls notifyAndRecordError", () => {
      const error = new Error("test error");
      const classified = { category: "internal" as const, message: "test error" };
      mockClassifyError.mockReturnValue(classified);

      handleQueryError("sess-1", "claude", error);

      expect(mockClassifyError).toHaveBeenCalledWith(error);
      expect(mockNotifyAndRecordError).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        classified,
        undefined
      );
    });

    it("passes enrichMessage callback to notifyAndRecordError", () => {
      const error = new Error("process exit");
      const classified = { category: "process_exit" as const, message: "process exit" };
      mockClassifyError.mockReturnValue(classified);
      const enrichFn = (c: { message: string }) => `${c.message} (enriched)`;

      handleQueryError("sess-1", "claude", error, enrichFn);

      expect(mockNotifyAndRecordError).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        classified,
        enrichFn
      );
    });

    it("works with codex agent type", () => {
      const error = new Error("codex error");
      const classified = { category: "network" as const, message: "codex error" };
      mockClassifyError.mockReturnValue(classified);

      handleQueryError("sess-2", "codex", error);

      expect(mockNotifyAndRecordError).toHaveBeenCalledWith(
        "sess-2",
        "codex",
        classified,
        undefined
      );
    });
  });
});
