import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// ============================================================================

const {
  mockSendMessage,
  mockSendError,
  mockEmitAgentSessionId,
  mockEmitSessionIdle,
  mockEmitSessionError,
  mockEmitSessionTitle,
  mockClassifyStopReason,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockSendError: vi.fn(),
  mockEmitAgentSessionId: vi.fn(),
  mockEmitSessionIdle: vi.fn(),
  mockEmitSessionError: vi.fn(),
  mockEmitSessionTitle: vi.fn(),
  mockClassifyStopReason: vi.fn(),
}));

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: {
    sendMessage: mockSendMessage,
    sendError: mockSendError,
    emitSystemMessage: vi.fn(),
    emitAgentSessionId: mockEmitAgentSessionId,
    emitSessionIdle: mockEmitSessionIdle,
    emitSessionError: mockEmitSessionError,
    emitSessionTitle: mockEmitSessionTitle,
  },
}));

vi.mock("../agents/lifecycle", () => ({
  classifyStopReason: mockClassifyStopReason,
}));

// Mock the Claude Agent SDK's listSessions (used via dynamic import in title fetch)
const { mockListSessions } = vi.hoisted(() => ({
  mockListSessions: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: mockListSessions,
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import {
  processMessage,
  deserializeMessage,
  type ProcessMessageOptions,
} from "../agents/claude/message-processor";
import { createStreamContext, type StreamContext } from "../agents/claude/stream-context";
import type { SessionState } from "../agents/claude/claude-session";

// ============================================================================
// Helpers
// ============================================================================

function makeOpts(overrides: Partial<ProcessMessageOptions> = {}): ProcessMessageOptions {
  return {
    sessionId: "sess-1",
    generatorId: "sess-1/123",
    model: "sonnet",
    isResume: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return { ...overrides };
}

function makeCtx(overrides: Partial<StreamContext> = {}): StreamContext {
  return { ...createStreamContext(), ...overrides };
}

// ============================================================================
// Tests: deserializeMessage
// ============================================================================

describe("deserializeMessage", () => {
  it("round-trips a plain object", () => {
    const input = { type: "assistant", message: { role: "assistant", content: "hi" } };
    const result = deserializeMessage(input, "gen-1");
    expect(result).toEqual(input);
  });

  it("replaces circular references with [Circular]", () => {
    const obj: any = { type: "test" };
    obj.self = obj;
    const result = deserializeMessage(obj, "gen-1");
    expect(result).not.toBeNull();
    expect(result!.self).toBe("[Circular]");
  });

  it("returns null for truly unserializable values", () => {
    // BigInt throws on JSON.stringify
    const result = deserializeMessage({ val: BigInt(42) }, "gen-1");
    expect(result).toBeNull();
  });

  it("preserves nested structures", () => {
    const input = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      parent_tool_use_id: "parent-1",
    };
    const result = deserializeMessage(input, "gen-1");
    expect(result).toEqual(input);
  });
});

// ============================================================================
// Tests: processMessage
// ============================================================================

describe("processMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyStopReason.mockReturnValue(null);
  });

  // --------------------------------------------------------------------------
  // Side effect ordering
  // --------------------------------------------------------------------------

  describe("side effect ordering", () => {
    it("stop_reason error emits session.error via canonical event", () => {
      mockClassifyStopReason.mockReturnValue({ message: "max tokens", category: "max_tokens" });
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "truncated", stop_reason: "max_tokens" },
      };

      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockEmitSessionError).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        "max tokens",
        "max_tokens"
      );
    });
  });

  // --------------------------------------------------------------------------
  // agent_session_id capture
  // --------------------------------------------------------------------------

  describe("agent_session_id capture", () => {
    it("captures session_id on first message (one-shot)", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "" },
        session_id: "sdk-sess-1",
      };
      const session = makeSession();

      processMessage(msg, makeCtx(), session, makeOpts());

      expect(mockEmitAgentSessionId).toHaveBeenCalledWith("sess-1", "sdk-sess-1");
      expect(session.agentSessionIdCaptured).toBe(true);
    });

    it("does not re-capture when agentSessionIdCaptured is true", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "" },
        session_id: "sdk-sess-2",
      };
      const session = makeSession({ agentSessionIdCaptured: true });

      processMessage(msg, makeCtx(), session, makeOpts());

      expect(mockEmitAgentSessionId).not.toHaveBeenCalled();
    });

    it("skips capture in resume mode", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "" },
        session_id: "sdk-sess-1",
      };
      const session = makeSession();

      processMessage(msg, makeCtx(), session, makeOpts({ isResume: true }));

      expect(mockEmitAgentSessionId).not.toHaveBeenCalled();
      expect(session.agentSessionIdCaptured).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // stop_reason classification
  // --------------------------------------------------------------------------

  describe("stop_reason classification", () => {
    it("emits session.error when classifyStopReason returns an error", () => {
      mockClassifyStopReason.mockReturnValue({ message: "max tokens", category: "max_tokens" });
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "truncated", stop_reason: "max_tokens" },
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(mockEmitSessionError).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        "max tokens",
        "max_tokens"
      );
      expect(ctx.stopReasonError).toBe(true);
    });

    it("does not send error for end_turn", () => {
      mockClassifyStopReason.mockReturnValue(null);
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "done", stop_reason: "end_turn" },
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(mockSendError).not.toHaveBeenCalled();
      expect(ctx.stopReasonError).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // result/success
  // --------------------------------------------------------------------------

  describe("result/success", () => {
    it("sets querySucceeded and emits session.idle", () => {
      const msg = { type: "result", subtype: "success" };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.querySucceeded).toBe(true);
      expect(mockEmitSessionIdle).toHaveBeenCalledWith("sess-1", "claude");
    });

    it("skips idle emit when stopReasonError is already set", () => {
      const msg = { type: "result", subtype: "success" };
      const ctx = makeCtx({ stopReasonError: true });

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.querySucceeded).toBe(true);
      expect(mockEmitSessionIdle).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // result/error_during_execution
  // --------------------------------------------------------------------------

  describe("result/error_during_execution", () => {
    it("captures lastResultError from errors array", () => {
      const msg = {
        type: "result",
        subtype: "error_during_execution",
        errors: ["No conversation found with session ID: abc-123"],
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.lastResultError).toBe("No conversation found with session ID: abc-123");
    });

    it("joins multiple errors with semicolons", () => {
      const msg = {
        type: "result",
        subtype: "error_during_execution",
        errors: ["error one", "error two"],
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.lastResultError).toBe("error one; error two");
    });

    it("falls back to error string when errors array is empty", () => {
      const msg = {
        type: "result",
        subtype: "error_during_execution",
        errors: [],
        error: "fallback error",
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.lastResultError).toBe("fallback error");
    });

    it("falls back to 'unknown' when no error info provided", () => {
      const msg = {
        type: "result",
        subtype: "error_during_execution",
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(ctx.lastResultError).toBe("unknown");
    });
  });

  // --------------------------------------------------------------------------
  // Canonical event emission
  // --------------------------------------------------------------------------

  describe("canonical event emission", () => {
    it("emits agent.session_id when session_id is captured", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "" },
        session_id: "sdk-sess-1",
      };
      const session = makeSession();
      processMessage(msg, makeCtx(), session, makeOpts());

      expect(mockEmitAgentSessionId).toHaveBeenCalledWith("sess-1", "sdk-sess-1");
    });

    it("does not emit agent.session_id during resume", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "" },
        session_id: "sdk-sess-1",
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts({ isResume: true }));

      expect(mockEmitAgentSessionId).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Title emission on result/success
  // --------------------------------------------------------------------------

  describe("title emission", () => {
    it("fetches and emits session title on first result/success", async () => {
      mockListSessions.mockResolvedValue([
        { sessionId: "sdk-sess-1", summary: "Fix login page CSS" },
      ]);

      const msg = { type: "result", subtype: "success", session_id: "sdk-sess-1" };
      const ctx = makeCtx();
      const session = makeSession({ cwd: "/path/to/project" });

      processMessage(msg, ctx, session, makeOpts());

      expect(ctx.titleFetched).toBe(true);

      // Wait for the fire-and-forget async title fetch to complete
      await vi.waitFor(() => {
        expect(mockEmitSessionTitle).toHaveBeenCalledWith("sess-1", "claude", "Fix login page CSS");
      });
    });

    it("does not emit title when titleFetched is already true", () => {
      const msg = { type: "result", subtype: "success", session_id: "sdk-sess-1" };
      const ctx = makeCtx({ titleFetched: true });
      const session = makeSession({ cwd: "/path/to/project" });

      processMessage(msg, ctx, session, makeOpts());

      expect(mockListSessions).not.toHaveBeenCalled();
    });

    it("does not emit title when session has no cwd", () => {
      const msg = { type: "result", subtype: "success", session_id: "sdk-sess-1" };
      const ctx = makeCtx();
      const session = makeSession(); // no cwd

      processMessage(msg, ctx, session, makeOpts());

      expect(ctx.titleFetched).toBe(false);
      expect(mockListSessions).not.toHaveBeenCalled();
    });

    it("does not emit title when no matching SDK session is found", async () => {
      mockListSessions.mockResolvedValue([
        { sessionId: "other-session", summary: "Some other task" },
      ]);

      const msg = { type: "result", subtype: "success", session_id: "sdk-sess-1" };
      const ctx = makeCtx();
      const session = makeSession({ cwd: "/path/to/project" });

      processMessage(msg, ctx, session, makeOpts());

      // Wait for the async operation to complete
      await vi.waitFor(() => {
        expect(mockListSessions).toHaveBeenCalled();
      });

      expect(mockEmitSessionTitle).not.toHaveBeenCalled();
    });

    it("handles listSessions errors gracefully without blocking", async () => {
      mockListSessions.mockRejectedValue(new Error("SDK unavailable"));

      const msg = { type: "result", subtype: "success", session_id: "sdk-sess-1" };
      const ctx = makeCtx();
      const session = makeSession({ cwd: "/path/to/project" });

      // Should not throw
      processMessage(msg, ctx, session, makeOpts());

      expect(ctx.titleFetched).toBe(true);

      // Wait for the async operation to reject gracefully
      await vi.waitFor(() => {
        expect(mockListSessions).toHaveBeenCalled();
      });

      expect(mockEmitSessionTitle).not.toHaveBeenCalled();
    });
  });
});
