import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FRONTEND_NOTIFICATIONS, FRONTEND_RPC_METHODS } from "../protocol";
import { buildMessageResponse, buildErrorResponse, buildEnterPlanModeNotification } from "./builders";

// We need to test FrontendClient which is a singleton. To get a fresh instance
// per test we re-import the module.
let FrontendClient: any;
let FrontendClientModule: any;

function createMockTunnel() {
  return {
    addMethod: vi.fn(),
    notify: vi.fn(),
    request: vi.fn().mockResolvedValue({}),
    handleLine: vi.fn(),
    stop: vi.fn(),
  };
}

describe("FrontendClient", () => {
  let mockTunnel: ReturnType<typeof createMockTunnel>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Fresh import to reset singleton state
    vi.resetModules();
    FrontendClientModule = await import("../frontend-client");
    FrontendClient = FrontendClientModule.FrontendClient;
    mockTunnel = createMockTunnel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Tunnel management
  // ==========================================================================

  describe("attachTunnel / detachTunnel", () => {
    it("sendMessage does not throw when no tunnel (error is caught internally)", () => {
      // sendMessage has a try/catch that swallows the error for resilience
      expect(() => FrontendClient.sendMessage(buildMessageResponse())).not.toThrow();
    });

    it("requestExitPlanMode rejects when no tunnel is attached", async () => {
      await expect(
        FrontendClient.requestExitPlanMode({ sessionId: "s", toolInput: {} })
      ).rejects.toThrow("FrontendClient tunnel not attached");
    });

    it("works after attaching a tunnel", () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.sendMessage(buildMessageResponse());
      expect(mockTunnel.notify).toHaveBeenCalled();
    });

    it("request rejects after detaching the tunnel", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.detachTunnel();
      // sendMessage won't throw (catches internally), but requests will reject
      await expect(
        FrontendClient.requestExitPlanMode({ sessionId: "s", toolInput: {} })
      ).rejects.toThrow("FrontendClient tunnel not attached");
    });
  });

  // ==========================================================================
  // Outgoing notifications
  // ==========================================================================

  describe("sendMessage", () => {
    it("sends a message notification", () => {
      FrontendClient.attachTunnel(mockTunnel);
      const msg = buildMessageResponse();
      FrontendClient.sendMessage(msg);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.MESSAGE, msg);
    });

    it("does not throw when tunnel.notify fails (frontend disconnected)", () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.notify.mockImplementation(() => {
        throw new Error("Socket closed");
      });

      expect(() => FrontendClient.sendMessage(buildMessageResponse())).not.toThrow();
    });
  });

  describe("sendError", () => {
    it("sends an error notification", () => {
      FrontendClient.attachTunnel(mockTunnel);
      const err = buildErrorResponse();
      FrontendClient.sendError(err);

      expect(mockTunnel.notify).toHaveBeenCalledWith(FRONTEND_NOTIFICATIONS.QUERY_ERROR, err);
    });
  });

  describe("sendEnterPlanModeNotification", () => {
    it("sends enter plan mode notification", () => {
      FrontendClient.attachTunnel(mockTunnel);
      const notif = buildEnterPlanModeNotification();
      FrontendClient.sendEnterPlanModeNotification(notif);

      expect(mockTunnel.notify).toHaveBeenCalledWith(
        FRONTEND_NOTIFICATIONS.ENTER_PLAN_MODE,
        notif
      );
    });
  });

  // ==========================================================================
  // Outgoing requests (with timeout)
  // ==========================================================================

  describe("requestExitPlanMode", () => {
    it("sends request to frontend and returns response", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ approved: true, turnId: "turn-1" });

      const result = await FrontendClient.requestExitPlanMode({
        sessionId: "sess-1",
        toolInput: {},
      });

      expect(mockTunnel.request).toHaveBeenCalledWith(FRONTEND_RPC_METHODS.EXIT_PLAN_MODE, {
        sessionId: "sess-1",
        toolInput: {},
      });
      expect(result).toEqual({ approved: true, turnId: "turn-1" });
    });

    it("rejects on timeout (30s)", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockReturnValue(new Promise(() => {})); // never resolves

      const promise = FrontendClient.requestExitPlanMode({
        sessionId: "sess-1",
        toolInput: {},
      });

      vi.advanceTimersByTime(30_001);
      await expect(promise).rejects.toThrow("timed out after 30000ms");
    });
  });

  describe("requestAskUserQuestion", () => {
    it("sends question request and returns answers", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ answers: ["Yes"] });

      const result = await FrontendClient.requestAskUserQuestion({
        sessionId: "sess-1",
        questions: [{ question: "Continue?", options: ["Yes", "No"] }],
      });

      expect(result).toEqual({ answers: ["Yes"] });
    });
  });

  describe("requestGetDiff", () => {
    it("sends diff request with 10s timeout", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockReturnValue(new Promise(() => {}));

      const promise = FrontendClient.requestGetDiff({ sessionId: "sess-1" });
      vi.advanceTimersByTime(10_001);
      await expect(promise).rejects.toThrow("timed out after 10000ms");
    });
  });

  describe("requestDiffComment", () => {
    it("sends diff comment request", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({ success: true });

      const result = await FrontendClient.requestDiffComment({
        sessionId: "sess-1",
        comments: [{ file: "test.ts", lineNumber: 10, body: "Fix this" }],
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe("requestGetTerminalOutput", () => {
    it("sends terminal output request", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      mockTunnel.request.mockResolvedValue({
        output: "test output",
        source: "terminal",
        isRunning: true,
      });

      const result = await FrontendClient.requestGetTerminalOutput({ sessionId: "sess-1" });
      expect(result.output).toBe("test output");
      expect(result.source).toBe("terminal");
    });
  });

  // ==========================================================================
  // Incoming event handlers
  // ==========================================================================

  describe("onQuery", () => {
    it("registers a handler for query notifications", () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.onQuery(vi.fn());

      expect(mockTunnel.addMethod).toHaveBeenCalledWith("query", expect.any(Function));
    });

    it("calls handler with parsed request (type stripped)", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      const handler = vi.fn().mockResolvedValue(undefined);
      FrontendClient.onQuery(handler);

      // Get the registered handler and call it
      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      await registeredHandler({
        type: "query",
        id: "sess-1",
        agentType: "claude",
        prompt: "Hello",
        options: { cwd: "/test" },
      });

      expect(handler).toHaveBeenCalledWith({
        id: "sess-1",
        agentType: "claude",
        prompt: "Hello",
        options: { cwd: "/test" },
      });
    });

    it("ignores invalid requests", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      const handler = vi.fn();
      FrontendClient.onQuery(handler);

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      await registeredHandler({ invalid: true });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onCancel", () => {
    it("registers a handler for cancel requests", () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.onCancel(vi.fn());

      expect(mockTunnel.addMethod).toHaveBeenCalledWith("cancel", expect.any(Function));
    });
  });

  describe("onClaudeAuth", () => {
    it("rejects invalid requests", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.onClaudeAuth(vi.fn());

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      await expect(registeredHandler({ invalid: true })).rejects.toThrow(
        "Invalid claudeAuth request"
      );
    });
  });

  describe("onWorkspaceInit", () => {
    it("rejects invalid requests", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.onWorkspaceInit(vi.fn());

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      await expect(registeredHandler({ invalid: true })).rejects.toThrow(
        "Invalid workspaceInit request"
      );
    });
  });

  describe("onContextUsage", () => {
    it("rejects invalid requests", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      FrontendClient.onContextUsage(vi.fn());

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      await expect(registeredHandler({ invalid: true })).rejects.toThrow(
        "Invalid contextUsage request"
      );
    });
  });

  describe("onUpdatePermissionMode", () => {
    it("ignores invalid requests without throwing", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      const handler = vi.fn();
      FrontendClient.onUpdatePermissionMode(handler);

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      const result = await registeredHandler({ invalid: true });

      expect(handler).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe("onResetGenerator", () => {
    it("ignores invalid requests without throwing", async () => {
      FrontendClient.attachTunnel(mockTunnel);
      const handler = vi.fn();
      FrontendClient.onResetGenerator(handler);

      const registeredHandler = mockTunnel.addMethod.mock.calls[0][1];
      const result = await registeredHandler({ invalid: true });

      expect(handler).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});
