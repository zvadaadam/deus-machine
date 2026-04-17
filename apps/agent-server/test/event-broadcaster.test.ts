import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FRONTEND_NOTIFICATIONS, FRONTEND_RPC_METHODS } from "../protocol";
import { AGENT_EVENT_NAMES } from "@shared/agent-events";
import {
  buildMessageResponse,
  buildErrorResponse,
  buildEnterPlanModeNotification,
} from "./builders";

// We need to test EventBroadcaster which is a singleton. To get a fresh instance
// per test we re-import the module.
let EventBroadcaster: any;
let EventBroadcasterModule: any;

function createMockTunnel() {
  return {
    addMethod: vi.fn(),
    notify: vi.fn(),
    request: vi.fn().mockResolvedValue({}),
    handleLine: vi.fn(),
    stop: vi.fn(),
  };
}

describe("EventBroadcaster", () => {
  let mockTunnel: ReturnType<typeof createMockTunnel>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Fresh import to reset singleton state
    vi.resetModules();
    EventBroadcasterModule = await import("../event-broadcaster");
    EventBroadcaster = EventBroadcasterModule.EventBroadcaster;
    mockTunnel = createMockTunnel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Tunnel management
  // ==========================================================================

  describe("attachTunnel / detachTunnel", () => {
    it("sendMessage does not throw when no tunnel (broadcasts to empty set)", () => {
      expect(() => EventBroadcaster.sendMessage(buildMessageResponse())).not.toThrow();
    });

    it("requestExitPlanMode throws when no tunnel is attached", () => {
      expect(() => EventBroadcaster.requestExitPlanMode({ sessionId: "s", toolInput: {} })).toThrow(
        "EventBroadcaster tunnel not attached"
      );
    });

    it("works after attaching a tunnel", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.sendMessage(buildMessageResponse());
      expect(mockTunnel.notify).toHaveBeenCalled();
    });

    it("request throws after detaching the tunnel", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.detachTunnel(mockTunnel);
      // sendMessage won't throw (broadcasts to empty set), but requests will throw
      expect(() => EventBroadcaster.requestExitPlanMode({ sessionId: "s", toolInput: {} })).toThrow(
        "EventBroadcaster tunnel not attached"
      );
    });

    it("broadcasts notifications to all attached tunnels", () => {
      const tunnel2 = createMockTunnel();
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.attachTunnel(tunnel2);
      const msg = buildMessageResponse();
      EventBroadcaster.sendMessage(msg);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.MESSAGE, msg);
      expect(tunnel2.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.MESSAGE, msg);
    });

    it("removes dead tunnels that throw on notify", () => {
      const tunnel2 = createMockTunnel();
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.attachTunnel(tunnel2);

      // First tunnel throws (dead connection)
      mockTunnel.notify.mockImplementation(() => {
        throw new Error("Socket closed");
      });

      EventBroadcaster.sendMessage(buildMessageResponse());

      // tunnel2 should still work, mockTunnel removed
      tunnel2.notify.mockClear();
      EventBroadcaster.sendMessage(buildMessageResponse());
      expect(tunnel2.notify).toHaveBeenCalledTimes(1);
      expect(mockTunnel.notify).toHaveBeenCalledTimes(1); // only the first call
    });

    it("detachTunnel without args clears all tunnels", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.attachTunnel(createMockTunnel());
      EventBroadcaster.detachTunnel();
      // No tunnels left, request should throw
      expect(() => EventBroadcaster.requestExitPlanMode({ sessionId: "s", toolInput: {} })).toThrow(
        "EventBroadcaster tunnel not attached"
      );
    });

    it("detachTunnel with specific tunnel only removes that one", async () => {
      const tunnel2 = createMockTunnel();
      tunnel2.request.mockResolvedValue({ approved: true });
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.attachTunnel(tunnel2);
      EventBroadcaster.detachTunnel(mockTunnel);

      // tunnel2 still available
      const result = await EventBroadcaster.requestExitPlanMode({
        sessionId: "s",
        toolInput: {},
      });
      expect(result).toEqual({ approved: true });
    });
  });

  // ==========================================================================
  // Outgoing notifications
  // ==========================================================================

  describe("sendMessage", () => {
    it("sends a message notification", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const msg = buildMessageResponse();
      EventBroadcaster.sendMessage(msg);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.MESSAGE, msg);
    });

    it("does not throw when tunnel.notify fails (frontend disconnected)", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.notify.mockImplementation(() => {
        throw new Error("Socket closed");
      });

      expect(() => EventBroadcaster.sendMessage(buildMessageResponse())).not.toThrow();
    });
  });

  describe("sendError", () => {
    it("sends an error notification", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const err = buildErrorResponse();
      EventBroadcaster.sendError(err);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.QUERY_ERROR, err);
    });
  });

  describe("sendEnterPlanModeNotification", () => {
    it("sends enter plan mode notification", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const notif = buildEnterPlanModeNotification();
      EventBroadcaster.sendEnterPlanModeNotification(notif);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.ENTER_PLAN_MODE, notif);
    });
  });

  // ==========================================================================
  // Outgoing requests (with timeout)
  // ==========================================================================

  describe("requestExitPlanMode", () => {
    it("sends request to frontend and returns response", async () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ approved: true, turnId: "turn-1" });

      const result = await EventBroadcaster.requestExitPlanMode({
        sessionId: "sess-1",
        toolInput: {},
      });

      expect(mockTunnel.request).toHaveBeenCalledWith(FRONTEND_RPC_METHODS.EXIT_PLAN_MODE, {
        sessionId: "sess-1",
        toolInput: {},
      });
      expect(result).toEqual({ approved: true, turnId: "turn-1" });
    });

    // No timeout test — user-facing RPCs (plan approval, questions) wait
    // indefinitely. The user may close the laptop and return later.
  });

  describe("requestAskUserQuestion", () => {
    it("sends question request and returns answers", async () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ answers: ["Yes"] });

      const result = await EventBroadcaster.requestAskUserQuestion({
        sessionId: "sess-1",
        questions: [{ question: "Continue?", options: ["Yes", "No"] }],
      });

      expect(result).toEqual({ answers: ["Yes"] });
    });
  });

  describe("requestGetDiff", () => {
    it("sends diff request with 10s timeout", async () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.request.mockReturnValue(new Promise(() => {}));

      const promise = EventBroadcaster.requestGetDiff({ sessionId: "sess-1" });
      vi.advanceTimersByTime(10_001);
      await expect(promise).rejects.toThrow("timed out after 10000ms");
    });
  });

  describe("requestDiffComment", () => {
    it("sends diff comment request", async () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ success: true });

      const result = await EventBroadcaster.requestDiffComment({
        sessionId: "sess-1",
        comments: [{ file: "test.ts", lineNumber: 10, body: "Fix this" }],
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe("requestGetTerminalOutput", () => {
    it("sends terminal output request", async () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({
        output: "test output",
        source: "terminal",
        isRunning: true,
      });

      const result = await EventBroadcaster.requestGetTerminalOutput({ sessionId: "sess-1" });
      expect(result.output).toBe("test output");
      expect(result.source).toBe("terminal");
    });
  });

  // ==========================================================================
  // Canonical event emission (agent-server protocol)
  // ==========================================================================

  describe("emitEvent", () => {
    it("broadcasts event using event.type as the JSON-RPC method", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const event = {
        type: AGENT_EVENT_NAMES.SESSION_STARTED,
        sessionId: "sess-1",
        agentHarness: "claude",
      };
      EventBroadcaster.emitEvent(event);

      expect(mockTunnel.notify).toHaveBeenCalledWith(AGENT_EVENT_NAMES.SESSION_STARTED, event);
    });

    it("does not throw when no tunnels are attached", () => {
      expect(() =>
        EventBroadcaster.emitEvent({
          type: AGENT_EVENT_NAMES.SESSION_IDLE,
          sessionId: "sess-1",
          agentHarness: "claude",
        })
      ).not.toThrow();
    });

    it("broadcasts to all connected tunnels", () => {
      const tunnel2 = createMockTunnel();
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.attachTunnel(tunnel2);

      const event = {
        type: AGENT_EVENT_NAMES.SESSION_ERROR,
        sessionId: "sess-1",
        agentHarness: "claude",
        error: "something broke",
        category: "internal",
      };
      EventBroadcaster.emitEvent(event);

      expect(mockTunnel.notify).toHaveBeenCalledWith(AGENT_EVENT_NAMES.SESSION_ERROR, event);
      expect(tunnel2.notify).toHaveBeenCalledWith(AGENT_EVENT_NAMES.SESSION_ERROR, event);
    });
  });

  describe("emitSessionStarted", () => {
    it("broadcasts session.started event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitSessionStarted("sess-1", "claude");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.SESSION_STARTED,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.SESSION_STARTED,
          sessionId: "sess-1",
          agentHarness: "claude",
        })
      );
    });
  });

  describe("emitSessionIdle", () => {
    it("broadcasts session.idle event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitSessionIdle("sess-1", "codex");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.SESSION_IDLE,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.SESSION_IDLE,
          sessionId: "sess-1",
          agentHarness: "codex",
        })
      );
    });
  });

  describe("emitSessionError", () => {
    it("broadcasts session.error event with error details", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitSessionError("sess-1", "claude", "API key invalid", "auth");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.SESSION_ERROR,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.SESSION_ERROR,
          sessionId: "sess-1",
          agentHarness: "claude",
          error: "API key invalid",
          category: "auth",
        })
      );
    });
  });

  describe("emitSessionCancelled", () => {
    it("broadcasts session.cancelled event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitSessionCancelled("sess-1", "claude");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.SESSION_CANCELLED,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.SESSION_CANCELLED,
          sessionId: "sess-1",
          agentHarness: "claude",
        })
      );
    });
  });

  describe("emitAssistantMessage", () => {
    it("broadcasts message.assistant event with message payload", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const message = {
        id: "msg-1",
        role: "assistant" as const,
        content: [{ type: "text", text: "Hello" }],
      };
      EventBroadcaster.emitAssistantMessage("sess-1", "claude", message, "sonnet");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.MESSAGE_ASSISTANT,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.MESSAGE_ASSISTANT,
          sessionId: "sess-1",
          agentHarness: "claude",
          message,
          model: "sonnet",
        })
      );
    });

    it("omits model when not provided", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitAssistantMessage("sess-1", "claude", {
        id: "msg-1",
        role: "assistant",
        content: [],
      });

      const payload = mockTunnel.notify.mock.calls[0][1];
      expect(payload.model).toBeUndefined();
    });
  });

  describe("emitToolResultMessage", () => {
    it("broadcasts message.tool_result event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const message = {
        id: "msg-2",
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "t1" }],
      };
      EventBroadcaster.emitToolResultMessage("sess-1", "claude", message, "opus");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.MESSAGE_TOOL_RESULT,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.MESSAGE_TOOL_RESULT,
          sessionId: "sess-1",
          message,
          model: "opus",
        })
      );
    });
  });

  describe("emitMessageResult", () => {
    it("broadcasts message.result event with subtype and usage", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      const usage = { input_tokens: 100, output_tokens: 50 };
      EventBroadcaster.emitMessageResult("sess-1", "claude", "success", usage);

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.MESSAGE_RESULT,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.MESSAGE_RESULT,
          sessionId: "sess-1",
          subtype: "success",
          usage,
        })
      );
    });

    it("omits usage when not provided", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitMessageResult("sess-1", "claude", "success");

      const payload = mockTunnel.notify.mock.calls[0][1];
      expect(payload.usage).toBeUndefined();
    });
  });

  describe("emitMessageCancelled", () => {
    it("broadcasts message.cancelled event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitMessageCancelled("sess-1", "claude");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.MESSAGE_CANCELLED,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.MESSAGE_CANCELLED,
          sessionId: "sess-1",
          agentHarness: "claude",
        })
      );
    });
  });

  describe("emitAgentSessionId", () => {
    it("broadcasts agent.session_id event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitAgentSessionId("sess-1", "sdk-abc-123");

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.AGENT_SESSION_ID,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.AGENT_SESSION_ID,
          sessionId: "sess-1",
          agentSessionId: "sdk-abc-123",
        })
      );
    });
  });

  describe("emitRequestOpened", () => {
    it("broadcasts request.opened event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitRequestOpened("req-1", "sess-1", "claude", "tool_approval", {
        tool: "bash",
      });

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.REQUEST_OPENED,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.REQUEST_OPENED,
          requestId: "req-1",
          sessionId: "sess-1",
          agentHarness: "claude",
          requestType: "tool_approval",
          data: { tool: "bash" },
        })
      );
    });
  });

  describe("emitToolRequest", () => {
    it("broadcasts tool.request event", () => {
      EventBroadcaster.attachTunnel(mockTunnel);
      EventBroadcaster.emitToolRequest("req-1", "sess-1", "getDiff", { file: "test.ts" }, 10000);

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        AGENT_EVENT_NAMES.TOOL_REQUEST,
        expect.objectContaining({
          type: AGENT_EVENT_NAMES.TOOL_REQUEST,
          requestId: "req-1",
          sessionId: "sess-1",
          method: "getDiff",
          params: { file: "test.ts" },
          timeoutMs: 10000,
        })
      );
    });
  });
});
