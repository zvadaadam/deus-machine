import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ============================================================================

const {
  mockPersistMessageCancelled,
  mockPersistMessageCreated,
  mockPersistPartDone,
  mockPersistMessageDone,
  mockPersistSessionStarted,
  mockPersistSessionIdle,
  mockPersistSessionError,
  mockPersistSessionCancelled,
  mockPersistAgentSessionId,
  mockPersistSessionTitle,
  mockInvalidate,
  mockBroadcast,
} = vi.hoisted(() => ({
  mockPersistMessageCreated: vi.fn(() => ({ ok: true, value: "msg-id" })),
  mockPersistMessageCancelled: vi.fn(() => ({ ok: true, value: "msg-id" })),
  mockPersistPartDone: vi.fn(() => ({ ok: true, value: "part-id" })),
  mockPersistMessageDone: vi.fn(() => ({ ok: true, value: "msg-id" })),
  mockPersistSessionStarted: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionIdle: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionError: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionCancelled: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistAgentSessionId: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionTitle: vi.fn(() => ({ ok: true, value: undefined })),
  mockInvalidate: vi.fn(),
  mockBroadcast: vi.fn(),
}));

vi.mock("../../../src/services/agent/persistence", () => ({
  persistMessageCancelled: mockPersistMessageCancelled,
  persistMessageCreated: mockPersistMessageCreated,
  persistPartDone: mockPersistPartDone,
  persistMessageDone: mockPersistMessageDone,
  persistSessionStarted: mockPersistSessionStarted,
  persistSessionIdle: mockPersistSessionIdle,
  persistSessionError: mockPersistSessionError,
  persistSessionCancelled: mockPersistSessionCancelled,
  persistAgentSessionId: mockPersistAgentSessionId,
  persistSessionTitle: mockPersistSessionTitle,
}));

vi.mock("../../../src/services/query-engine", () => ({
  invalidate: mockInvalidate,
}));

vi.mock("../../../src/services/ws.service", () => ({
  broadcast: mockBroadcast,
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { createAgentEventHandler } from "../../../src/services/agent/event-handler";
import type { AgentEvent } from "../../../../shared/agent-events";

const handleAgentEvent = createAgentEventHandler();

// ============================================================================
// Tests
// ============================================================================

describe("handleAgentEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  describe("session.started", () => {
    const event: AgentEvent = {
      type: "session.started",
      sessionId: "sess-1",
      agentHarness: "claude",
    };

    it("persists and invalidates on success", () => {
      handleAgentEvent(event);

      expect(mockPersistSessionStarted).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });

    it("skips invalidation on persistence failure", () => {
      mockPersistSessionStarted.mockReturnValue({ ok: false, error: "DB error" });

      handleAgentEvent(event);

      expect(mockPersistSessionStarted).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe("session.idle", () => {
    const event: AgentEvent = {
      type: "session.idle",
      sessionId: "sess-1",
      agentHarness: "claude",
    };

    it("persists and invalidates workspaces, sessions, session, stats", () => {
      handleAgentEvent(event);

      expect(mockPersistSessionIdle).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });

    it("skips invalidation on persistence failure", () => {
      mockPersistSessionIdle.mockReturnValue({ ok: false, error: "DB error" });

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe("session.error", () => {
    const event: AgentEvent = {
      type: "session.error",
      sessionId: "sess-1",
      agentHarness: "claude",
      error: "Rate limit",
      category: "rate_limit",
    };

    it("persists error details and invalidates", () => {
      handleAgentEvent(event);

      expect(mockPersistSessionError).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });
  });

  describe("session.cancelled", () => {
    const event: AgentEvent = {
      type: "session.cancelled",
      sessionId: "sess-1",
      agentHarness: "claude",
    };

    it("persists and invalidates", () => {
      handleAgentEvent(event);

      expect(mockPersistSessionCancelled).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });
  });

  // ==========================================================================
  // Messages
  // ==========================================================================

  describe("message.cancelled", () => {
    const event: AgentEvent = {
      type: "message.cancelled",
      sessionId: "sess-1",
      agentHarness: "claude",
    };

    it("persists and invalidates messages, sessions, session, stats", () => {
      handleAgentEvent(event);

      expect(mockPersistMessageCancelled).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["messages", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });
  });

  // ==========================================================================
  // Turn, message & part lifecycle
  // ==========================================================================

  describe("turn.started", () => {
    it("logs without persisting or invalidating", () => {
      const event: AgentEvent = {
        type: "turn.started",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-1",
        turnId: "turn-1",
      };

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe("message.created", () => {
    it("persists message row and invalidates", () => {
      const event: AgentEvent = {
        type: "message.created",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-1",
        role: "assistant",
      };

      handleAgentEvent(event);

      expect(mockPersistMessageCreated).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalled();
    });
  });

  describe("part.created", () => {
    const event: AgentEvent = {
      type: "part.created",
      sessionId: "sess-1",
      agentHarness: "claude",
      messageId: "msg-1",
      partId: "p1",
      part: { type: "TEXT", id: "p1", sessionId: "sess-1", messageId: "msg-1", text: "" },
    };

    it("persists the part so in-flight parts survive session switches", () => {
      handleAgentEvent(event);

      expect(mockPersistPartDone).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it("broadcasts part:created q:event to frontend", () => {
      handleAgentEvent(event);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame).toEqual({
        type: "q:event",
        event: "part:created",
        data: {
          sessionId: "sess-1",
          agentHarness: "claude",
          messageId: "msg-1",
          partId: "p1",
          part: { type: "TEXT", id: "p1", sessionId: "sess-1", messageId: "msg-1", text: "" },
        },
      });
    });
  });

  describe("part.delta", () => {
    const event: AgentEvent = {
      type: "part.delta",
      sessionId: "sess-1",
      agentHarness: "claude",
      partId: "p1",
      delta: "Hello",
    };

    it("does not persist or invalidate (streaming event)", () => {
      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(mockPersistPartDone).not.toHaveBeenCalled();
    });

    it("broadcasts part:delta q:event to frontend", () => {
      handleAgentEvent(event);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame).toEqual({
        type: "q:event",
        event: "part:delta",
        data: {
          sessionId: "sess-1",
          agentHarness: "claude",
          partId: "p1",
          delta: "Hello",
        },
      });
    });
  });

  describe("part.done", () => {
    const event: AgentEvent = {
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
        text: "Hello world",
      },
    };

    it("persists the part without invalidating (frontend gets data via q:event)", () => {
      handleAgentEvent(event);

      expect(mockPersistPartDone).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it("broadcasts part:done q:event to frontend", () => {
      handleAgentEvent(event);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame).toEqual({
        type: "q:event",
        event: "part:done",
        data: {
          sessionId: "sess-1",
          agentHarness: "claude",
          messageId: "msg-1",
          partId: "p1",
          part: {
            type: "TEXT",
            id: "p1",
            sessionId: "sess-1",
            messageId: "msg-1",
            text: "Hello world",
          },
        },
      });
    });

    it("broadcasts even when persistence fails", () => {
      mockPersistPartDone.mockReturnValue({ ok: false, error: "DB error" });

      handleAgentEvent(event);

      expect(mockPersistPartDone).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
      // Broadcast should still happen — the frontend needs the event for streaming UI
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
    });
  });

  describe("message.done", () => {
    const event: AgentEvent = {
      type: "message.done",
      sessionId: "sess-1",
      agentHarness: "claude",
      messageId: "msg-1",
      stopReason: "end_turn",
      parts: [],
    };

    it("persists stop_reason without invalidating (frontend already has data)", () => {
      handleAgentEvent(event);

      expect(mockPersistMessageDone).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it("skips invalidation on persistence failure", () => {
      mockPersistMessageDone.mockReturnValue({ ok: false, error: "DB error" });

      handleAgentEvent(event);

      expect(mockPersistMessageDone).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe("turn.completed", () => {
    it("invalidates messages without persisting", () => {
      const event: AgentEvent = {
        type: "turn.completed",
        sessionId: "sess-1",
        agentHarness: "claude",
        messageId: "msg-1",
        finishReason: "end_turn",
        tokens: { input: 100, output: 50 },
        cost: 0.003,
      };

      handleAgentEvent(event);

      // No invalidation — all part data already streamed via q:event.
      // Session status change (session.idle) handles UI update.
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Interaction requests (no DB write, no invalidation)
  // ==========================================================================

  // ==========================================================================
  // Tool relay
  // ==========================================================================

  // ==========================================================================
  // Metadata
  // ==========================================================================

  describe("agent.session_id", () => {
    it("persists agent session ID and invalidates session resources", () => {
      const event: AgentEvent = {
        type: "agent.session_id",
        sessionId: "sess-1",
        agentSessionId: "claude-sdk-abc",
      };

      handleAgentEvent(event);

      expect(mockPersistAgentSessionId).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });
  });

  describe("session.title", () => {
    const event: AgentEvent = {
      type: "session.title",
      sessionId: "sess-1",
      agentHarness: "claude",
      title: "Fix login page CSS",
    };

    it("persists session title and invalidates session resources", () => {
      handleAgentEvent(event);

      expect(mockPersistSessionTitle).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: ["sess-1"],
      });
    });

    it("skips invalidation on persistence failure", () => {
      mockPersistSessionTitle.mockReturnValue({ ok: false, error: "DB error" });

      handleAgentEvent(event);

      expect(mockPersistSessionTitle).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Exhaustiveness
  // ==========================================================================

  describe("exhaustiveness", () => {
    it("handles all known event types without throwing", () => {
      // This test verifies the .exhaustive() pattern works by calling
      // handleAgentEvent with every event type. If a new event type is added
      // to AgentEvent but not handled, TypeScript compilation will fail.
      const events: AgentEvent[] = [
        { type: "session.started", sessionId: "s", agentHarness: "claude" },
        { type: "session.idle", sessionId: "s", agentHarness: "claude" },
        {
          type: "session.error",
          sessionId: "s",
          agentHarness: "claude",
          error: "e",
          category: "internal",
        },
        { type: "session.cancelled", sessionId: "s", agentHarness: "claude" },
        { type: "message.cancelled", sessionId: "s", agentHarness: "claude" },
        // Turn, message & part lifecycle
        { type: "turn.started", sessionId: "s", agentHarness: "claude", messageId: "m" },
        {
          type: "message.created",
          sessionId: "s",
          agentHarness: "claude",
          messageId: "m",
          role: "assistant",
        },
        {
          type: "part.created",
          sessionId: "s",
          agentHarness: "claude",
          messageId: "m",
          partId: "p",
          part: { type: "TEXT", id: "p", sessionId: "s", messageId: "m", text: "" },
        },
        { type: "part.delta", sessionId: "s", agentHarness: "claude", partId: "p", delta: "x" },
        {
          type: "part.done",
          sessionId: "s",
          agentHarness: "claude",
          messageId: "m",
          partId: "p",
          part: { type: "TEXT", id: "p", sessionId: "s", messageId: "m", text: "x" },
        },
        {
          type: "message.done",
          sessionId: "s",
          agentHarness: "claude",
          messageId: "m",
          stopReason: "end_turn",
          parts: [],
        },
        {
          type: "turn.completed",
          sessionId: "s",
          agentHarness: "claude",
          messageId: "m",
          finishReason: "end_turn",
        },
        { type: "agent.session_id", sessionId: "s", agentSessionId: "a" },
        { type: "session.title", sessionId: "s", agentHarness: "claude", title: "Fix bug" },
      ];

      for (const event of events) {
        expect(() => handleAgentEvent(event)).not.toThrow();
      }
    });
  });
});
