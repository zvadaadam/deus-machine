import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentClient, type AgentClientOptions } from "../../../src/services/agent/client";
import { AGENT_RPC_METHODS, AGENT_EVENT_NAMES } from "@shared/agent-events";

// ============================================================================
// Test server helper
// ============================================================================

interface TestServer {
  httpServer: HttpServer;
  wss: WebSocketServer;
  port: number;
  url: string;
  /** Most recent connected client WebSocket (server side) */
  lastClient: WebSocket | null;
  /** All messages received by the server */
  received: unknown[];
  close: () => void;
}

async function createTestServer(): Promise<TestServer> {
  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received: unknown[] = [];
  let lastClient: WebSocket | null = null;

  wss.on("connection", (ws) => {
    lastClient = ws;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : data.toString());
        received.push(msg);
      } catch {
        // Ignore
      }
    });
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    httpServer,
    wss,
    port,
    url: `ws://127.0.0.1:${port}`,
    get lastClient() {
      return lastClient;
    },
    received,
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

// Helper to wait for a condition
function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 20);
    };
    check();
  });
}

// Helper: send a JSON-RPC response back to the client
function sendResponse(ws: WebSocket, id: number, result: unknown): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

// Helper: send a JSON-RPC notification to the client
function sendNotification(ws: WebSocket, method: string, params: unknown): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentClient", () => {
  let server: TestServer;
  let client: AgentClient;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(() => {
    client?.disconnect();
    server?.close();
  });

  // ==========================================================================
  // Connection & Handshake
  // ==========================================================================

  describe("connection and handshake", () => {
    it("connects and completes the initialize handshake", async () => {
      const onConnected = vi.fn();

      client = new AgentClient({
        url: server.url,
        onConnected,
      });
      client.connect();

      // Wait for the server to receive the initialize request
      await waitFor(() => server.received.length > 0);

      const initRequest = server.received[0] as any;
      expect(initRequest.method).toBe(AGENT_RPC_METHODS.INITIALIZE);
      expect(initRequest.params).toEqual({ version: "1.0", capabilities: {} });
      expect(initRequest.id).toBeDefined();

      // Respond with agents list
      sendResponse(server.lastClient!, initRequest.id, {
        version: "1.0",
        agents: [
          {
            type: "claude",
            capabilities: {
              auth: true,
              workspaceInit: true,
              contextUsage: true,
              modelSwitch: "in-session",
              multiTurn: true,
              sessionResume: true,
              permissionMode: true,
            },
            initialized: true,
          },
        ],
      });

      // Wait for the "initialized" notification
      await waitFor(() => server.received.length >= 2);

      const initializedNotif = server.received[1] as any;
      expect(initializedNotif.method).toBe(AGENT_RPC_METHODS.INITIALIZED);

      // Verify onConnected callback was called
      await waitFor(() => onConnected.mock.calls.length > 0);
      expect(onConnected).toHaveBeenCalledWith([expect.objectContaining({ type: "claude" })]);

      // Verify client state
      expect(client.isConnected()).toBe(true);
      expect(client.getAgents()).toHaveLength(1);
      expect(client.getAgents()[0].type).toBe("claude");
    });

    it("reports disconnection via callback", async () => {
      const onDisconnected = vi.fn();
      const onConnected = vi.fn();

      client = new AgentClient({
        url: server.url,
        onConnected,
        onDisconnected,
      });
      client.connect();

      // Complete handshake
      await waitFor(() => server.received.length > 0);
      const initReq = server.received[0] as any;
      sendResponse(server.lastClient!, initReq.id, {
        version: "1.0",
        agents: [],
      });
      await waitFor(() => onConnected.mock.calls.length > 0);

      // Close server-side connection
      server.lastClient!.close();

      await waitFor(() => onDisconnected.mock.calls.length > 0, 3000);
      expect(onDisconnected).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });
  });

  // ==========================================================================
  // Event handling
  // ==========================================================================

  describe("event handling", () => {
    async function connectAndHandshake(opts?: Partial<AgentClientOptions>): Promise<AgentClient> {
      const ac = new AgentClient({
        url: server.url,
        ...opts,
      });
      ac.connect();

      await waitFor(() => server.received.length > 0);
      const initReq = server.received[0] as any;
      sendResponse(server.lastClient!, initReq.id, {
        version: "1.0",
        agents: [],
      });
      await waitFor(() => ac.isConnected());
      // Clear received for cleaner assertions on subsequent messages
      server.received.length = 0;
      return ac;
    }

    it("dispatches canonical agent events to the onEvent handler", async () => {
      const events: unknown[] = [];
      client = await connectAndHandshake({
        onEvent: (event) => events.push(event),
      });

      // Send a session.started notification from server
      sendNotification(server.lastClient!, AGENT_EVENT_NAMES.SESSION_STARTED, {
        type: "session.started",
        sessionId: "sess-1",
        agentHarness: "claude",
      });

      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: "session.started",
        sessionId: "sess-1",
        agentHarness: "claude",
      });
    });

    it("dispatches message.assistant events", async () => {
      const events: unknown[] = [];
      client = await connectAndHandshake({
        onEvent: (event) => events.push(event),
      });

      sendNotification(server.lastClient!, AGENT_EVENT_NAMES.MESSAGE_ASSISTANT, {
        type: "message.assistant",
        sessionId: "sess-1",
        agentHarness: "claude",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
        },
      });

      await waitFor(() => events.length > 0);
      expect((events[0] as any).type).toBe("message.assistant");
      expect((events[0] as any).message.id).toBe("msg-1");
    });

    it("ignores malformed event payloads without crashing", async () => {
      const events: unknown[] = [];
      client = await connectAndHandshake({
        onEvent: (event) => events.push(event),
      });

      // Send an invalid event (missing required fields)
      sendNotification(server.lastClient!, AGENT_EVENT_NAMES.SESSION_STARTED, {
        type: "session.started",
        // missing sessionId and agentHarness
      });

      // Give time for processing
      await new Promise((r) => setTimeout(r, 100));
      expect(events).toHaveLength(0); // Should be dropped, not crash
    });
  });

  // ==========================================================================
  // RPC methods
  // ==========================================================================

  describe("RPC methods", () => {
    async function connectAndHandshake(): Promise<AgentClient> {
      const ac = new AgentClient({ url: server.url });
      ac.connect();

      await waitFor(() => server.received.length > 0);
      const initReq = server.received[0] as any;
      sendResponse(server.lastClient!, initReq.id, {
        version: "1.0",
        agents: [],
      });
      await waitFor(() => ac.isConnected());
      server.received.length = 0;
      return ac;
    }

    it("sendTurnStart sends a turn/start request", async () => {
      client = await connectAndHandshake();

      const ws = server.lastClient!;

      // Listen for the request and respond
      const responsePromise = new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.method === AGENT_RPC_METHODS.TURN_START) {
            sendResponse(ws, msg.id, { accepted: true });
            resolve();
          }
        });
      });

      const result = await client.sendTurnStart({
        sessionId: "sess-1",
        agentHarness: "claude",
        prompt: "Hello",
        options: { cwd: "/tmp" },
      });

      await responsePromise;
      expect(result).toEqual({ accepted: true });
    });

    it("rejects when not connected", async () => {
      client = new AgentClient({ url: server.url });
      // Don't connect

      await expect(
        client.sendTurnStart({
          sessionId: "sess-1",
          agentHarness: "claude",
          prompt: "Hello",
          options: { cwd: "/tmp" },
        })
      ).rejects.toThrow("not connected");
    });
  });

  // ==========================================================================
  // Disconnect
  // ==========================================================================

  describe("disconnect", () => {
    it("prevents reconnection after disconnect()", async () => {
      client = new AgentClient({ url: server.url });
      client.connect();

      await waitFor(() => server.received.length > 0);

      client.disconnect();

      expect(client.isConnected()).toBe(false);

      // Ensure no reconnection attempts happen
      await new Promise((r) => setTimeout(r, 200));
      // Client should stay disconnected
      expect(client.isConnected()).toBe(false);
    });
  });
});
