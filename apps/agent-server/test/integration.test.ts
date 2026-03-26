import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { RpcConnection, wsTransport } from "../rpc-connection";

/**
 * Integration tests: Real WebSockets, real JSON-RPC 2.0 tunnels,
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
