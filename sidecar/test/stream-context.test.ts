import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// ============================================================================

const { mockGetSession, mockPersistCancellation, mockNotifyAndRecordError, mockUpdateSessionStatus } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockPersistCancellation: vi.fn(),
    mockNotifyAndRecordError: vi.fn(),
    mockUpdateSessionStatus: vi.fn(() => ({ ok: true, value: "sess-id" })),
  }));

vi.mock("../agents/claude/claude-session", () => ({
  getSession: mockGetSession,
}));

vi.mock("../agents/query-lifecycle", () => ({
  persistCancellation: mockPersistCancellation,
  notifyAndRecordError: mockNotifyAndRecordError,
}));

vi.mock("../db/session-writer", () => ({
  updateSessionStatus: mockUpdateSessionStatus,
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import {
  createStreamContext,
  resolveStreamOutcome,
  executeOutcome,
  type StreamContext,
  type StreamOutcome,
} from "../agents/claude/stream-context";
import type { SessionState } from "../agents/claude/claude-session";

// ============================================================================
// Helpers
// ============================================================================

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return { ...overrides };
}

function makeCtx(overrides: Partial<StreamContext> = {}): StreamContext {
  return { ...createStreamContext(), ...overrides };
}

// ============================================================================
// Tests
// ============================================================================

describe("StreamContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // createStreamContext
  // ==========================================================================

  describe("createStreamContext", () => {
    it("returns zeroed context", () => {
      const ctx = createStreamContext();
      expect(ctx.querySucceeded).toBe(false);
      expect(ctx.stopReasonError).toBe(false);
      expect(ctx.messageCount).toBe(0);
      expect(ctx.lastResultError).toBeNull();
      expect(ctx.firstMessageTime).toBeNull();
    });
  });

  // ==========================================================================
  // resolveStreamOutcome — pure classification, no side effects
  // ==========================================================================

  describe("resolveStreamOutcome", () => {
    it("cancelledByUser -> cancelled (post-loop path, error=null)", () => {
      const session = makeSession({ cancelledByUser: true });
      const result = resolveStreamOutcome(makeCtx(), session, null, "sess-1");
      expect(result).toEqual({ type: "cancelled" });
    });

    it("cancelledByUser -> cancelled (catch path, error set)", () => {
      const session = makeSession({ cancelledByUser: true });
      const result = resolveStreamOutcome(makeCtx(), session, new Error("boom"), "sess-1");
      expect(result).toEqual({ type: "cancelled" });
    });

    it("cancel takes priority over querySucceeded", () => {
      const session = makeSession({ cancelledByUser: true });
      const ctx = makeCtx({ querySucceeded: true });
      const result = resolveStreamOutcome(ctx, session, new Error("SIGINT"), "sess-1");
      expect(result.type).toBe("cancelled");
    });

    it("normal completion -> completed with stopReasonError=false", () => {
      const result = resolveStreamOutcome(makeCtx(), makeSession(), null, "sess-1");
      expect(result).toEqual({ type: "completed", stopReasonError: false });
    });

    it("max_tokens completion -> completed with stopReasonError=true", () => {
      const ctx = makeCtx({ stopReasonError: true });
      const result = resolveStreamOutcome(ctx, makeSession(), null, "sess-1");
      expect(result).toEqual({ type: "completed", stopReasonError: true });
    });

    it("catch + querySucceeded -> post_success_exit", () => {
      const ctx = makeCtx({ querySucceeded: true });
      const result = resolveStreamOutcome(ctx, makeSession(), new Error("SIGINT"), "sess-1");
      expect(result).toEqual({ type: "post_success_exit", stopReasonError: false });
    });

    it("catch + querySucceeded + stopReasonError -> post_success_exit preserves flag", () => {
      const ctx = makeCtx({ querySucceeded: true, stopReasonError: true });
      const result = resolveStreamOutcome(ctx, makeSession(), new Error("SIGINT"), "sess-1");
      expect(result).toEqual({ type: "post_success_exit", stopReasonError: true });
    });

    it("catch + genuine error + ownsSession=true (session matches)", () => {
      const session = makeSession();
      mockGetSession.mockReturnValue(session); // same reference
      const result = resolveStreamOutcome(makeCtx(), session, new Error("crash"), "sess-1");
      expect(result).toEqual({ type: "genuine_error", error: expect.any(Error), ownsSession: true });
    });

    it("catch + genuine error + ownsSession=true (session deleted / null)", () => {
      mockGetSession.mockReturnValue(undefined); // session cleaned up
      const result = resolveStreamOutcome(makeCtx(), makeSession(), new Error("crash"), "sess-1");
      expect(result).toEqual({ type: "genuine_error", error: expect.any(Error), ownsSession: true });
    });

    it("catch + genuine error + ownsSession=false (rapid re-query replaced session)", () => {
      const oldSession = makeSession();
      const newSession = makeSession(); // different reference
      mockGetSession.mockReturnValue(newSession);
      const result = resolveStreamOutcome(makeCtx(), oldSession, new Error("crash"), "sess-1");
      expect(result).toEqual({ type: "genuine_error", error: expect.any(Error), ownsSession: false });
    });
  });

  // ==========================================================================
  // executeOutcome — side effects
  // ==========================================================================

  describe("executeOutcome", () => {
    const generatorId = "sess-1/123";
    const baseOpts = { model: "sonnet", resume: undefined };

    it("cancelled -> calls persistCancellation", () => {
      const outcome: StreamOutcome = { type: "cancelled" };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockPersistCancellation).toHaveBeenCalledWith("sess-1", "claude", "sonnet");
    });

    it("completed -> calls updateSessionStatus('idle') when !stopReasonError", () => {
      const outcome: StreamOutcome = { type: "completed", stopReasonError: false };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockUpdateSessionStatus).toHaveBeenCalledWith("sess-1", "idle");
    });

    it("completed -> skips updateSessionStatus when stopReasonError=true", () => {
      const outcome: StreamOutcome = { type: "completed", stopReasonError: true };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
    });

    it("post_success_exit -> calls updateSessionStatus('idle') when !stopReasonError", () => {
      const outcome: StreamOutcome = { type: "post_success_exit", stopReasonError: false };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockUpdateSessionStatus).toHaveBeenCalledWith("sess-1", "idle");
    });

    it("post_success_exit -> skips updateSessionStatus when stopReasonError=true", () => {
      const outcome: StreamOutcome = { type: "post_success_exit", stopReasonError: true };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
    });

    it("genuine_error + ownsSession -> calls notifyAndRecordError", () => {
      const error = new Error("process exited with code 1");
      const outcome: StreamOutcome = { type: "genuine_error", error, ownsSession: true };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockNotifyAndRecordError).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({ message: "process exited with code 1" }),
        expect.any(Function)
      );
    });

    it("genuine_error + !ownsSession -> skips notifyAndRecordError", () => {
      const error = new Error("crash");
      const outcome: StreamOutcome = { type: "genuine_error", error, ownsSession: false };
      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);
      expect(mockNotifyAndRecordError).not.toHaveBeenCalled();
    });

    it("genuine_error enrichMessage includes resume info and messageCount for process_exit", () => {
      const error = new Error("Claude Code process exited with code 1");
      const outcome: StreamOutcome = { type: "genuine_error", error, ownsSession: true };
      const ctx = makeCtx({ messageCount: 12, lastResultError: "No conversation found" });
      const opts = { model: "sonnet", resume: "agent-sess-123" };

      executeOutcome(outcome, "sess-1", ctx, opts, generatorId);

      // Get the enrichMessage callback and call it with a process_exit classified error
      const enrichFn = mockNotifyAndRecordError.mock.calls[0][3];
      const enriched = enrichFn({ category: "process_exit", message: "Claude Code process exited with code 1" });
      expect(enriched).toContain("(resumed session)");
      expect(enriched).toContain("after 12 messages");
      expect(enriched).toContain("No conversation found");
    });

    it("genuine_error enrichMessage returns raw message for non-process_exit categories", () => {
      const error = new Error("Unauthorized");
      const outcome: StreamOutcome = { type: "genuine_error", error, ownsSession: true };

      executeOutcome(outcome, "sess-1", makeCtx(), baseOpts, generatorId);

      const enrichFn = mockNotifyAndRecordError.mock.calls[0][3];
      const enriched = enrichFn({ category: "auth", message: "Unauthorized" });
      expect(enriched).toBe("Unauthorized");
    });

    it("cancelled uses default model 'opus' when model not provided", () => {
      const outcome: StreamOutcome = { type: "cancelled" };
      executeOutcome(outcome, "sess-1", makeCtx(), {}, generatorId);
      expect(mockPersistCancellation).toHaveBeenCalledWith("sess-1", "claude", "opus");
    });
  });
});
