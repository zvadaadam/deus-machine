import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer } from "ws";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetRegisteredAgentHarnesses = vi.fn((): string[] => ["claude", "codex"]);
const mockEmitSessionCancelled = vi.fn();
const mockEmitMessageCancelled = vi.fn();
const mockGetAgent = vi.fn(() => undefined);

vi.mock("../agents/registry", () => ({
  getRegisteredAgentHarnesses: () => mockGetRegisteredAgentHarnesses(),
  getAgent: (...args: unknown[]) => mockGetAgent(args[0]),
}));

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: {
    emitSessionCancelled: (sessionId: string, agentHarness: string) =>
      mockEmitSessionCancelled(sessionId, agentHarness),
    emitMessageCancelled: (sessionId: string, agentHarness: string) =>
      mockEmitMessageCancelled(sessionId, agentHarness),
  },
}));

import {
  buildHealthResponse,
  handleHttpRequest,
  setAgentsInitialized,
  isAgentsInitialized,
  isShuttingDown,
  setShuttingDown,
  trackSession,
  untrackSession,
  getActiveSessionCount,
  getActiveSessions,
  waitForDrain,
  cancelRemainingSessions,
  resetHealthState,
  type HealthResponse,
} from "../health";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a minimal mock ServerResponse that captures writeHead + end calls. */
function createMockResponse() {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  return res;
}

/** Creates a minimal mock IncomingMessage with the given method and url. */
function createMockRequest(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("health module", () => {
  beforeEach(() => {
    resetHealthState();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // buildHealthResponse
  // ==========================================================================

  describe("buildHealthResponse", () => {
    it("returns a valid health response with all required fields", () => {
      const response = buildHealthResponse(null);

      expect(response.status).toBe("ok");
      expect(typeof response.uptime).toBe("number");
      expect(response.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof response.memoryMb).toBe("number");
      expect(response.memoryMb).toBeGreaterThan(0);
      expect(response.agents).toEqual(["claude", "codex"]);
      expect(response.connections).toBe(0);
      expect(response.version).toBe("1.0.0");
      expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("reports 0 connections when wss is null", () => {
      const response = buildHealthResponse(null);
      expect(response.connections).toBe(0);
    });

    it("reports connection count from the WebSocket server", () => {
      // Create a mock WSS with clients Set
      const mockWss = {
        clients: new Set(["ws1", "ws2", "ws3"]),
      } as unknown as WebSocketServer;

      const response = buildHealthResponse(mockWss);
      expect(response.connections).toBe(3);
    });

    it("uses agent types from the registry", () => {
      mockGetRegisteredAgentHarnesses.mockReturnValueOnce(["claude"]);
      const response = buildHealthResponse(null);
      expect(response.agents).toEqual(["claude"]);
    });

    it("returns empty agents array when none registered", () => {
      mockGetRegisteredAgentHarnesses.mockReturnValueOnce([]);
      const response = buildHealthResponse(null);
      expect(response.agents).toEqual([]);
    });
  });

  // ==========================================================================
  // handleHttpRequest
  // ==========================================================================

  describe("handleHttpRequest", () => {
    describe("GET /health", () => {
      it("returns 200 with JSON health response", () => {
        const req = createMockRequest("GET", "/health");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });

        const body = JSON.parse(res.end.mock.calls[0][0]) as HealthResponse;
        expect(body.status).toBe("ok");
        expect(body.version).toBe("1.0.0");
      });
    });

    describe("GET /readyz", () => {
      it("returns 503 when agents are not initialized", () => {
        const req = createMockRequest("GET", "/readyz");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.status).toBe("not ready");
        expect(body.reason).toBe("agents not initialized");
      });

      it("returns 200 when agents are initialized", () => {
        setAgentsInitialized(true);
        const req = createMockRequest("GET", "/readyz");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.status).toBe("ready");
      });

      it("returns 503 when shutting down even if agents are initialized", () => {
        setAgentsInitialized(true);
        setShuttingDown(true);
        const req = createMockRequest("GET", "/readyz");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.status).toBe("not ready");
        expect(body.reason).toBe("shutting down");
      });
    });

    describe("unknown routes", () => {
      it("returns 404 for unknown paths", () => {
        const req = createMockRequest("GET", "/unknown");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" });
        expect(res.end).toHaveBeenCalledWith("Not Found");
      });

      it("returns 404 for POST to /health", () => {
        const req = createMockRequest("POST", "/health");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" });
      });

      it("returns 404 for root path", () => {
        const req = createMockRequest("GET", "/");
        const res = createMockResponse();

        handleHttpRequest(req, res, null);

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" });
      });
    });
  });

  // ==========================================================================
  // State management
  // ==========================================================================

  describe("state management", () => {
    it("agentsInitialized defaults to false", () => {
      expect(isAgentsInitialized()).toBe(false);
    });

    it("setAgentsInitialized updates the flag", () => {
      setAgentsInitialized(true);
      expect(isAgentsInitialized()).toBe(true);
    });

    it("shuttingDown defaults to false", () => {
      expect(isShuttingDown()).toBe(false);
    });

    it("setShuttingDown updates the flag", () => {
      setShuttingDown(true);
      expect(isShuttingDown()).toBe(true);
    });

    it("resetHealthState clears all state", () => {
      setAgentsInitialized(true);
      setShuttingDown(true);
      trackSession("sess-1", "claude");

      resetHealthState();

      expect(isAgentsInitialized()).toBe(false);
      expect(isShuttingDown()).toBe(false);
      expect(getActiveSessionCount()).toBe(0);
    });
  });

  // ==========================================================================
  // Session tracking
  // ==========================================================================

  describe("session tracking", () => {
    it("tracks a session", () => {
      trackSession("sess-1", "claude");
      expect(getActiveSessionCount()).toBe(1);
      expect(getActiveSessions().get("sess-1")).toBe("claude");
    });

    it("untracks a session", () => {
      trackSession("sess-1", "claude");
      untrackSession("sess-1");
      expect(getActiveSessionCount()).toBe(0);
    });

    it("tracks multiple sessions", () => {
      trackSession("sess-1", "claude");
      trackSession("sess-2", "codex");
      expect(getActiveSessionCount()).toBe(2);
    });

    it("untracking non-existent session is a no-op", () => {
      untrackSession("nonexistent");
      expect(getActiveSessionCount()).toBe(0);
    });

    it("overwrites agent type for same session id", () => {
      trackSession("sess-1", "claude");
      trackSession("sess-1", "codex");
      expect(getActiveSessionCount()).toBe(1);
      expect(getActiveSessions().get("sess-1")).toBe("codex");
    });
  });

  // ==========================================================================
  // waitForDrain
  // ==========================================================================

  describe("waitForDrain", () => {
    it("resolves immediately when no active sessions", async () => {
      const result = await waitForDrain({ drainTimeoutMs: 1000 });
      expect(result).toBe(true);
    });

    it("resolves true when sessions drain within timeout", async () => {
      trackSession("sess-1", "claude");

      // Simulate session completing after 50ms
      setTimeout(() => untrackSession("sess-1"), 50);

      const result = await waitForDrain({ drainTimeoutMs: 2000 });
      expect(result).toBe(true);
    });

    it("resolves false when drain timeout is reached", async () => {
      trackSession("sess-1", "claude");

      // Session never completes — drain should timeout
      const result = await waitForDrain({ drainTimeoutMs: 200 });
      expect(result).toBe(false);

      // Clean up
      untrackSession("sess-1");
    });

    it("handles multiple sessions draining at different times", async () => {
      trackSession("sess-1", "claude");
      trackSession("sess-2", "codex");

      setTimeout(() => untrackSession("sess-1"), 30);
      setTimeout(() => untrackSession("sess-2"), 80);

      const result = await waitForDrain({ drainTimeoutMs: 2000 });
      expect(result).toBe(true);
      expect(getActiveSessionCount()).toBe(0);
    });
  });

  // ==========================================================================
  // cancelRemainingSessions
  // ==========================================================================

  describe("cancelRemainingSessions", () => {
    it("emits both message.cancelled and session.cancelled when no agent handler", async () => {
      trackSession("sess-1", "claude");
      trackSession("sess-2", "codex");

      await cancelRemainingSessions();

      expect(mockEmitMessageCancelled).toHaveBeenCalledTimes(2);
      expect(mockEmitSessionCancelled).toHaveBeenCalledTimes(2);
      expect(mockEmitSessionCancelled).toHaveBeenCalledWith("sess-1", "claude");
      expect(mockEmitSessionCancelled).toHaveBeenCalledWith("sess-2", "codex");
    });

    it("calls agent.cancel() when agent handler is available", async () => {
      const mockCancel = vi.fn().mockResolvedValue(undefined);
      mockGetAgent.mockReturnValue({ cancel: mockCancel } as any);

      trackSession("sess-1", "claude");
      await cancelRemainingSessions();

      expect(mockCancel).toHaveBeenCalledWith("sess-1");
      expect(mockEmitSessionCancelled).not.toHaveBeenCalled();
    });

    it("falls back to direct events when agent.cancel() throws", async () => {
      const mockCancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
      mockGetAgent.mockReturnValue({ cancel: mockCancel } as any);

      trackSession("sess-1", "claude");
      await cancelRemainingSessions();

      expect(mockCancel).toHaveBeenCalledWith("sess-1");
      expect(mockEmitMessageCancelled).toHaveBeenCalledWith("sess-1", "claude");
      expect(mockEmitSessionCancelled).toHaveBeenCalledWith("sess-1", "claude");
    });

    it("clears active sessions after cancellation", async () => {
      trackSession("sess-1", "claude");
      await cancelRemainingSessions();
      expect(getActiveSessionCount()).toBe(0);
    });

    it("does nothing when no active sessions", async () => {
      await cancelRemainingSessions();
      expect(mockEmitSessionCancelled).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Integration: HTTP health endpoint over real HTTP server
// ============================================================================

describe("Integration: health endpoints over real HTTP", () => {
  let httpServer: ReturnType<typeof createHttpServer>;
  let port: number;

  beforeEach(async () => {
    resetHealthState();
    setAgentsInitialized(true);

    httpServer = createHttpServer((req, res) => {
      handleHttpRequest(req, res, null);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    httpServer.close();
  });

  it("GET /health returns 200 with valid JSON", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.0.0");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.memoryMb).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("GET /readyz returns 200 when ready", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("GET /readyz returns 503 when shutting down", async () => {
    setShuttingDown(true);

    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as { status: string; reason: string };
    expect(body.status).toBe("not ready");
    expect(body.reason).toBe("shutting down");
  });

  it("GET /unknown returns 404", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(response.status).toBe(404);
  });
});
