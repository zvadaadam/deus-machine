import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcConnection, type RpcTransport } from "../rpc-connection";
import { buildJsonRpcNotification, buildJsonRpcRequest, buildJsonRpcResponse } from "./builders";

/**
 * Creates a mock net.Socket with write and on methods.
 * Captures written data for assertions.
 */
function createMockSocket() {
  const written: string[] = [];
  return {
    socket: {
      write: vi.fn((data: string) => {
        written.push(data);
        return true;
      }),
      on: vi.fn(),
      destroy: vi.fn(),
    } as any,
    written,
  };
}

/**
 * Creates a mock RpcTransport (simulates WebSocket transport).
 * Captures sent data for assertions.
 */
function createMockWsTransport() {
  const sent: string[] = [];
  let closed = false;
  const transport: RpcTransport = {
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    isClosed: vi.fn(() => closed),
  };
  return {
    transport,
    sent,
    setClosed: (value: boolean) => {
      closed = value;
    },
  };
}

describe("RpcConnection", () => {
  let tunnel: RpcConnection;
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    mockSocket = createMockSocket();
    tunnel = new RpcConnection(mockSocket.socket);
  });

  // ==========================================================================
  // handleLine
  // ==========================================================================

  describe("handleLine", () => {
    it("returns false for invalid JSON", () => {
      const result = tunnel.handleLine("{not valid json");
      expect(result).toBe(false);
    });

    it("returns false for empty string", () => {
      const result = tunnel.handleLine("");
      expect(result).toBe(false);
    });

    it("returns false for valid JSON that is not JSON-RPC", () => {
      const result = tunnel.handleLine(JSON.stringify({ foo: "bar" }));
      expect(result).toBe(false);
    });

    it("returns true for valid JSON-RPC notification", () => {
      const notification = buildJsonRpcNotification("test", { key: "value" });
      const result = tunnel.handleLine(JSON.stringify(notification));
      expect(result).toBe(true);
    });

    it("returns true for valid JSON-RPC request", () => {
      const request = buildJsonRpcRequest("test", { key: "value" });
      const result = tunnel.handleLine(JSON.stringify(request));
      expect(result).toBe(true);
    });

    it("returns true for valid JSON-RPC response", () => {
      const response = buildJsonRpcResponse(1, { result: "ok" });
      const result = tunnel.handleLine(JSON.stringify(response));
      expect(result).toBe(true);
    });

    it("dispatches a request to a registered method handler", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      tunnel.addMethod("testMethod", handler);

      const request = buildJsonRpcRequest("testMethod", { data: "hello" });
      tunnel.handleLine(JSON.stringify(request));

      // Allow async processing
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledWith({ data: "hello" });
    });
  });

  // ==========================================================================
  // notify
  // ==========================================================================

  describe("notify", () => {
    it("writes a JSON-RPC notification to the socket", () => {
      tunnel.notify("eventName", { key: "value" });

      expect(mockSocket.socket.write).toHaveBeenCalled();
      const written = mockSocket.written[0];
      const parsed = JSON.parse(written.replace("\n", ""));
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("eventName");
      expect(parsed.params).toEqual({ key: "value" });
      expect(parsed.id).toBeUndefined();
    });

    it("appends a newline to each message", () => {
      tunnel.notify("test", {});
      expect(mockSocket.written[0]).toMatch(/\n$/);
    });
  });

  // ==========================================================================
  // request
  // ==========================================================================

  describe("request", () => {
    it("writes a JSON-RPC request with an id to the socket", () => {
      // Don't await — we just check the write happened
      void tunnel.request("getData", { query: "test" });

      expect(mockSocket.socket.write).toHaveBeenCalled();
      const written = mockSocket.written[0];
      const parsed = JSON.parse(written.replace("\n", ""));
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("getData");
      expect(parsed.params).toEqual({ query: "test" });
      expect(parsed.id).toBeDefined();
    });

    it("resolves when a matching response is received", async () => {
      const promise = tunnel.request("getInfo", { key: "val" });

      // Parse the request to get the id
      const written = mockSocket.written[0];
      const parsed = JSON.parse(written.replace("\n", ""));
      const requestId = parsed.id;

      // Feed back a matching response
      const response = buildJsonRpcResponse(requestId, { info: "result" });
      tunnel.handleLine(JSON.stringify(response));

      const result = await promise;
      expect(result).toEqual({ info: "result" });
    });
  });

  // ==========================================================================
  // addMethod
  // ==========================================================================

  describe("addMethod", () => {
    it("registers a handler that receives params and returns a result", async () => {
      const handler = vi.fn().mockResolvedValue({ computed: 42 });
      tunnel.addMethod("compute", handler);

      const request = buildJsonRpcRequest("compute", { input: 21 });
      tunnel.handleLine(JSON.stringify(request));

      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledWith({ input: 21 });

      // Verify the response was written back to the socket
      // First write is the response
      expect(mockSocket.written.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // stop
  // ==========================================================================

  describe("stop", () => {
    it("rejects pending requests", async () => {
      const promise = tunnel.request("slowMethod", {});
      tunnel.stop();

      await expect(promise).rejects.toThrow("RPC connection stopped");
    });

    it("can be called multiple times safely", () => {
      tunnel.stop();
      expect(() => tunnel.stop()).not.toThrow();
    });
  });
});

// ============================================================================
// RpcConnection with WebSocket transport (RpcTransport interface)
// ============================================================================

describe("RpcConnection (WebSocket transport)", () => {
  let tunnel: RpcConnection;
  let mockWs: ReturnType<typeof createMockWsTransport>;

  beforeEach(() => {
    mockWs = createMockWsTransport();
    tunnel = new RpcConnection(mockWs.transport);
  });

  // ==========================================================================
  // handleMessage (alias for handleLine, clearer for WS)
  // ==========================================================================

  describe("handleMessage", () => {
    it("returns false for invalid JSON", () => {
      const result = tunnel.handleMessage("{not valid json");
      expect(result).toBe(false);
    });

    it("returns true for valid JSON-RPC notification", () => {
      const notification = buildJsonRpcNotification("test", { key: "value" });
      const result = tunnel.handleMessage(JSON.stringify(notification));
      expect(result).toBe(true);
    });

    it("dispatches a request to a registered method handler", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      tunnel.addMethod("testMethod", handler);

      const request = buildJsonRpcRequest("testMethod", { data: "hello" });
      tunnel.handleMessage(JSON.stringify(request));

      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledWith({ data: "hello" });
    });
  });

  // ==========================================================================
  // notify (WebSocket — no newline framing)
  // ==========================================================================

  describe("notify", () => {
    it("sends a JSON-RPC notification via transport.send()", () => {
      tunnel.notify("eventName", { key: "value" });

      expect(mockWs.transport.send).toHaveBeenCalled();
      const sent = mockWs.sent[0];
      // WS transport does NOT append newlines — messages are complete frames
      expect(sent).not.toMatch(/\n$/);
      const parsed = JSON.parse(sent);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("eventName");
      expect(parsed.params).toEqual({ key: "value" });
      expect(parsed.id).toBeUndefined();
    });
  });

  // ==========================================================================
  // request
  // ==========================================================================

  describe("request", () => {
    it("sends a JSON-RPC request via transport.send()", () => {
      void tunnel.request("getData", { query: "test" });

      expect(mockWs.transport.send).toHaveBeenCalled();
      const sent = mockWs.sent[0];
      const parsed = JSON.parse(sent);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("getData");
      expect(parsed.params).toEqual({ query: "test" });
      expect(parsed.id).toBeDefined();
    });

    it("rejects when transport is closed", async () => {
      mockWs.setClosed(true);
      const promise = tunnel.request("getData", {});
      await expect(promise).rejects.toThrow("Transport is closed");
    });

    it("resolves when a matching response is received", async () => {
      const promise = tunnel.request("getInfo", { key: "val" });

      const sent = mockWs.sent[0];
      const parsed = JSON.parse(sent);
      const requestId = parsed.id;

      const response = buildJsonRpcResponse(requestId, { info: "result" });
      tunnel.handleMessage(JSON.stringify(response));

      const result = await promise;
      expect(result).toEqual({ info: "result" });
    });
  });

  // ==========================================================================
  // stop
  // ==========================================================================

  describe("stop", () => {
    it("rejects pending requests", async () => {
      const promise = tunnel.request("slowMethod", {});
      tunnel.stop();

      await expect(promise).rejects.toThrow("RPC connection stopped");
    });
  });
});
