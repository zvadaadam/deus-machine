import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { createServer as createHttpServer } from "http";
import { StringDecoder } from "string_decoder";
import { WebSocketServer, WebSocket } from "ws";
import { RpcConnection, wsTransport } from "../rpc-connection";

/**
 * Integration tests: Real Unix sockets, real JSON-RPC 2.0 tunnels,
 * no mocked dependencies except the SDK.
 */

// Helper to wait for a condition with timeout
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

// Helper to collect messages from a socket
function collectMessages(socket: net.Socket): unknown[] {
  const messages: unknown[] = [];
  let buffer = "";
  const decoder = new StringDecoder("utf8");

  socket.on("data", (data) => {
    buffer += decoder.write(data);
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // ignore parse errors
        }
      }
    }
  });

  return messages;
}

describe("Integration: RpcConnection over real Unix socket", () => {
  let server: net.Server;
  let socketPath: string;
  let serverSocket: net.Socket | null = null;
  let clientSocket: net.Socket | null = null;
  let serverTunnel: RpcConnection | null = null;
  let clientTunnel: RpcConnection | null = null;

  beforeEach(async () => {
    socketPath = path.join(os.tmpdir(), `agent-server-test-${process.pid}-${Date.now()}.sock`);

    // Clean up stale socket
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    // Create a real Unix domain socket server
    server = net.createServer((socket) => {
      serverSocket = socket;
      serverTunnel = new RpcConnection(socket);
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });

    // Create client connection
    clientSocket = await new Promise<net.Socket>((resolve) => {
      const sock = net.connect(socketPath, () => resolve(sock));
    });
    clientTunnel = new RpcConnection(clientSocket);

    // Wire up line-based framing for both sides
    wireLineFraming(clientSocket, clientTunnel);
    await waitFor(() => serverSocket !== null && serverTunnel !== null);
    wireLineFraming(serverSocket!, serverTunnel!);
  });

  afterEach(() => {
    clientTunnel?.stop();
    serverTunnel?.stop();
    clientSocket?.destroy();
    serverSocket?.destroy();
    server.close();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  function wireLineFraming(socket: net.Socket, tunnel: RpcConnection) {
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    socket.on("data", (data) => {
      buffer += decoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          tunnel.handleLine(line);
        }
      }
    });
  }

  // ==========================================================================
  // Notification delivery
  // ==========================================================================

  it("delivers a notification from client to server", async () => {
    const received: unknown[] = [];
    serverTunnel!.addMethod("testNotify", async (params) => {
      received.push(params);
      return undefined;
    });

    clientTunnel!.notify("testNotify", { hello: "world" });

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ hello: "world" });
  });

  it("delivers a notification from server to client", async () => {
    const received: unknown[] = [];
    clientTunnel!.addMethod("serverEvent", async (params) => {
      received.push(params);
      return undefined;
    });

    serverTunnel!.notify("serverEvent", { event: "data" });

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ event: "data" });
  });

  // ==========================================================================
  // Request/response (bidirectional RPC)
  // ==========================================================================

  it("completes a request/response round-trip (client → server)", async () => {
    serverTunnel!.addMethod("add", async (params: any) => {
      return { result: params.a + params.b };
    });

    const result = await clientTunnel!.request("add", { a: 3, b: 4 });
    expect(result).toEqual({ result: 7 });
  });

  it("completes a request/response round-trip (server → client)", async () => {
    clientTunnel!.addMethod("getUserInput", async () => {
      return { answer: "yes" };
    });

    const result = await serverTunnel!.request("getUserInput", {});
    expect(result).toEqual({ answer: "yes" });
  });

  it("handles multiple concurrent requests", async () => {
    serverTunnel!.addMethod("echo", async (params: any) => {
      // Simulate some async work
      await new Promise((r) => setTimeout(r, 10));
      return { echoed: params.message };
    });

    const results = await Promise.all([
      clientTunnel!.request("echo", { message: "one" }),
      clientTunnel!.request("echo", { message: "two" }),
      clientTunnel!.request("echo", { message: "three" }),
    ]);

    expect(results).toEqual([{ echoed: "one" }, { echoed: "two" }, { echoed: "three" }]);
  });

  // ==========================================================================
  // Bidirectional: interleaved requests and notifications
  // ==========================================================================

  it("supports interleaved bidirectional communication", async () => {
    const serverReceived: string[] = [];
    const clientReceived: string[] = [];

    // Server handles notifications and requests from client
    serverTunnel!.addMethod("clientNotify", async (params: any) => {
      serverReceived.push(params.msg);
      return undefined;
    });

    serverTunnel!.addMethod("getData", async () => {
      return { data: "from-server" };
    });

    // Client handles notifications from server
    clientTunnel!.addMethod("serverNotify", async (params: any) => {
      clientReceived.push(params.msg);
      return undefined;
    });

    clientTunnel!.addMethod("getInput", async () => {
      return { input: "from-client" };
    });

    // Fire mixed requests and notifications from both sides
    clientTunnel!.notify("clientNotify", { msg: "hello" });
    serverTunnel!.notify("serverNotify", { msg: "world" });
    const serverData = await clientTunnel!.request("getData", {});
    const clientData = await serverTunnel!.request("getInput", {});

    await waitFor(() => serverReceived.length > 0 && clientReceived.length > 0);

    expect(serverReceived).toContain("hello");
    expect(clientReceived).toContain("world");
    expect(serverData).toEqual({ data: "from-server" });
    expect(clientData).toEqual({ input: "from-client" });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  it("rejects pending requests when tunnel stops", async () => {
    serverTunnel!.addMethod("slowOp", async () => {
      await new Promise((r) => setTimeout(r, 10000)); // never finishes
      return {};
    });

    const promise = clientTunnel!.request("slowOp", {});

    // Stop the client tunnel, which should reject pending requests
    clientTunnel!.stop();

    await expect(promise).rejects.toThrow();
  });

  // ==========================================================================
  // Message framing correctness
  // ==========================================================================

  it("handles rapid-fire notifications without message loss", async () => {
    const received: number[] = [];

    serverTunnel!.addMethod("counter", async (params: any) => {
      received.push(params.n);
      return undefined;
    });

    const count = 50;
    for (let i = 0; i < count; i++) {
      clientTunnel!.notify("counter", { n: i });
    }

    await waitFor(() => received.length === count, 5000);
    expect(received.length).toBe(count);
    expect(received.sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});

// ============================================================================
// Integration: RpcConnection over real WebSocket
// ============================================================================

describe("Integration: RpcConnection over real WebSocket", () => {
  let httpServer: ReturnType<typeof createHttpServer>;
  let wss: WebSocketServer;
  let serverWs: WebSocket | null = null;
  let clientWs: WebSocket | null = null;
  let serverTunnel: RpcConnection | null = null;
  let clientTunnel: RpcConnection | null = null;
  let port: number;

  beforeEach(async () => {
    // Create a real WebSocket server on a dynamic port
    httpServer = createHttpServer();
    wss = new WebSocketServer({ server: httpServer });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    // Server side: accept connections and wire up RPC
    const serverReady = new Promise<void>((resolve) => {
      wss.on("connection", (ws) => {
        serverWs = ws;
        const transport = wsTransport(ws);
        serverTunnel = new RpcConnection(transport);

        ws.on("message", (data: Buffer | string) => {
          const msg = typeof data === "string" ? data : data.toString("utf8");
          serverTunnel!.handleMessage(msg);
        });

        resolve();
      });
    });

    // Client side: connect and wire up RPC
    clientWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });

    const clientTransport = wsTransport(clientWs);
    clientTunnel = new RpcConnection(clientTransport);

    clientWs.on("message", (data: Buffer | string) => {
      const msg = typeof data === "string" ? data : data.toString("utf8");
      clientTunnel!.handleMessage(msg);
    });

    await serverReady;
  });

  afterEach(() => {
    clientTunnel?.stop();
    serverTunnel?.stop();
    if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    if (serverWs && (serverWs as any).readyState === WebSocket.OPEN) (serverWs as any).close();
    wss.close();
    httpServer.close();
  });

  it("delivers a notification from client to server", async () => {
    const received: unknown[] = [];
    serverTunnel!.addMethod("testNotify", async (params) => {
      received.push(params);
      return undefined;
    });

    clientTunnel!.notify("testNotify", { hello: "ws-world" });

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ hello: "ws-world" });
  });

  it("completes a request/response round-trip (client -> server)", async () => {
    serverTunnel!.addMethod("add", async (params: any) => {
      return { result: params.a + params.b };
    });

    const result = await clientTunnel!.request("add", { a: 10, b: 20 });
    expect(result).toEqual({ result: 30 });
  });

  it("completes a request/response round-trip (server -> client)", async () => {
    clientTunnel!.addMethod("getUserInput", async () => {
      return { answer: "ws-yes" };
    });

    const result = await serverTunnel!.request("getUserInput", {});
    expect(result).toEqual({ answer: "ws-yes" });
  });

  it("handles multiple concurrent requests over WS", async () => {
    serverTunnel!.addMethod("echo", async (params: any) => {
      await new Promise((r) => setTimeout(r, 10));
      return { echoed: params.message };
    });

    const results = await Promise.all([
      clientTunnel!.request("echo", { message: "alpha" }),
      clientTunnel!.request("echo", { message: "beta" }),
      clientTunnel!.request("echo", { message: "gamma" }),
    ]);

    expect(results).toEqual([{ echoed: "alpha" }, { echoed: "beta" }, { echoed: "gamma" }]);
  });

  it("handles rapid-fire notifications without message loss over WS", async () => {
    const received: number[] = [];

    serverTunnel!.addMethod("counter", async (params: any) => {
      received.push(params.n);
      return undefined;
    });

    const count = 50;
    for (let i = 0; i < count; i++) {
      clientTunnel!.notify("counter", { n: i });
    }

    await waitFor(() => received.length === count, 5000);
    expect(received.length).toBe(count);
    expect(received.sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});
