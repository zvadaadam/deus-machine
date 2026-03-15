import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// ============================================================================

const {
  mockSendMessage,
  mockSendError,
  mockEmitAssistantMessage,
  mockEmitToolResultMessage,
  mockEmitMessageResult,
  mockEmitAgentSessionId,
  mockEmitSessionIdle,
  mockEmitSessionError,
  mockClassifyStopReason,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockSendError: vi.fn(),
  mockEmitAssistantMessage: vi.fn(),
  mockEmitToolResultMessage: vi.fn(),
  mockEmitMessageResult: vi.fn(),
  mockEmitAgentSessionId: vi.fn(),
  mockEmitSessionIdle: vi.fn(),
  mockEmitSessionError: vi.fn(),
  mockClassifyStopReason: vi.fn(),
}));

vi.mock("../frontend-client", () => ({
  FrontendClient: {
    sendMessage: mockSendMessage,
    sendError: mockSendError,
    emitAssistantMessage: mockEmitAssistantMessage,
    emitToolResultMessage: mockEmitToolResultMessage,
    emitMessageResult: mockEmitMessageResult,
    emitAgentSessionId: mockEmitAgentSessionId,
    emitSessionIdle: mockEmitSessionIdle,
    emitSessionError: mockEmitSessionError,
  },
}));

vi.mock("../agents/error-classifier", () => ({
  classifyStopReason: mockClassifyStopReason,
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
    it("assistant message: emits canonical event then sends to frontend (call order)", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "hello", stop_reason: "end_turn" },
        session_id: "sdk-sess-1",
      };
      const callOrder: string[] = [];
      mockEmitAssistantMessage.mockImplementation(() => callOrder.push("emit"));
      mockSendMessage.mockImplementation(() => callOrder.push("frontend"));

      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(callOrder.indexOf("emit")).toBeLessThan(callOrder.indexOf("frontend"));
    });

    it("stop_reason error sent AFTER sendMessage", () => {
      mockClassifyStopReason.mockReturnValue({ message: "max tokens", category: "max_tokens" });
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "truncated", stop_reason: "max_tokens" },
      };
      const callOrder: string[] = [];
      mockSendMessage.mockImplementation(() => callOrder.push("sendMessage"));
      mockSendError.mockImplementation(() => callOrder.push("sendError"));

      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(callOrder.indexOf("sendMessage")).toBeLessThan(callOrder.indexOf("sendError"));
    });
  });

  // --------------------------------------------------------------------------
  // Assistant messages
  // --------------------------------------------------------------------------

  describe("assistant messages", () => {
    it("emits canonical message.assistant event with correct args", () => {
      const msg = {
        type: "assistant",
        message: { id: "msg-1", role: "assistant", content: "response" },
        parent_tool_use_id: "parent-1",
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts({ model: "opus" }));

      expect(mockEmitAssistantMessage).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({
          id: "msg-1",
          role: "assistant",
          content: "response",
          parent_tool_use_id: "parent-1",
        }),
        "opus"
      );
    });

    it("sends message to frontend", () => {
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "response" },
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it("extracts parent_tool_use_id as null when missing", () => {
      const msg = {
        type: "assistant",
        message: { id: "msg-1", role: "assistant", content: "response" },
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockEmitAssistantMessage).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({
          parent_tool_use_id: null,
        }),
        "sonnet"
      );
    });
  });

  // --------------------------------------------------------------------------
  // User / tool_result messages
  // --------------------------------------------------------------------------

  describe("user messages with tool_result", () => {
    it("emits canonical message.tool_result event when content has tool_result block", () => {
      const msg = {
        type: "user",
        message: {
          id: "sdk-msg-2",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
        },
        parent_tool_use_id: "parent-1",
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockEmitToolResultMessage).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({
          id: "sdk-msg-2",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
          parent_tool_use_id: "parent-1",
        }),
        "sonnet"
      );
    });

    it("does not emit message.tool_result for user messages without tool_result", () => {
      const msg = {
        type: "user",
        message: { role: "user", content: "hello" },
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockEmitToolResultMessage).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalled(); // still sent to frontend
    });
  });

  // --------------------------------------------------------------------------
  // Frontend notification
  // --------------------------------------------------------------------------

  describe("frontend notification", () => {
    it("sends every message to frontend", () => {
      const msg = { type: "result", subtype: "success" };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockSendMessage).toHaveBeenCalledWith({
        id: "sess-1",
        type: "message",
        agentType: "claude",
        data: msg,
      });
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
    it("sends error and emits session.error when classifyStopReason returns an error", () => {
      mockClassifyStopReason.mockReturnValue({ message: "max tokens", category: "max_tokens" });
      const msg = {
        type: "assistant",
        message: { role: "assistant", content: "truncated", stop_reason: "max_tokens" },
      };
      const ctx = makeCtx();

      processMessage(msg, ctx, makeSession(), makeOpts());

      expect(mockSendError).toHaveBeenCalledWith({
        id: "sess-1",
        type: "error",
        error: "max tokens",
        agentType: "claude",
        category: "max_tokens",
      });
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
    it("emits message.assistant for assistant messages", () => {
      const msg = {
        type: "assistant",
        message: { id: "sdk-msg-1", role: "assistant", content: "hello", stop_reason: "end_turn" },
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts({ model: "opus" }));

      expect(mockEmitAssistantMessage).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({
          id: "sdk-msg-1",
          role: "assistant",
          content: "hello",
          stop_reason: "end_turn",
        }),
        "opus"
      );
    });

    it("emits message.tool_result for tool_result messages", () => {
      const msg = {
        type: "user",
        message: {
          id: "sdk-msg-2",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
        },
        parent_tool_use_id: "parent-1",
      };
      processMessage(msg, makeCtx(), makeSession(), makeOpts({ model: "sonnet" }));

      expect(mockEmitToolResultMessage).toHaveBeenCalledWith(
        "sess-1",
        "claude",
        expect.objectContaining({
          id: "sdk-msg-2",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
          parent_tool_use_id: "parent-1",
        }),
        "sonnet"
      );
    });

    it("emits message.result on result/success", () => {
      const msg = { type: "result", subtype: "success" };
      processMessage(msg, makeCtx(), makeSession(), makeOpts());

      expect(mockEmitMessageResult).toHaveBeenCalledWith("sess-1", "claude", "success");
    });

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
});
