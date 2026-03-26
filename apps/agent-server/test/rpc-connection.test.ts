import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcConnection, type RpcTransport } from "../rpc-connection";
import { buildJsonRpcNotification, buildJsonRpcRequest, buildJsonRpcResponse } from "./builders";

/**
 * Creates a mock RpcTransport.
 * Captures sent data for assertions.
 */
function createMockTransport() {
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
  let mock: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    mock = createMockTransport();
    tunnel = new RpcConnection(mock.transport);
  });

  // ==========================================================================
  // handleMessage (alias for handleLine, clearer for WS)
  // ==========================================================================

  describe("handleMessage", () => {
    it("returns false for invalid JSON", () => {
      const result = tunnel.handleMessage("{not valid json");
      expect(result).toBe(false);
    });

    it("returns false for empty string", () => {
      const result = tunnel.handleMessage("");
      expect(result).toBe(false);
    });

    it("returns false for valid JSON that is not JSON-RPC", () => {
      const result = tunnel.handleMessage(JSON.stringify({ foo: "bar" }));
      expect(result).toBe(false);
    });

    it("returns true for valid JSON-RPC request", () => {
      const request = buildJsonRpcRequest("test", { key: "value" });
      const result = tunnel.handleMessage(JSON.stringify(request));
      expect(result).toBe(true);
    });

    it("returns true for valid JSON-RPC response", () => {
      const response = buildJsonRpcResponse(1, { result: "ok" });
      const result = tunnel.handleMessage(JSON.stringify(response));
      expect(result).toBe(true);
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

      expect(mock.transport.send).toHaveBeenCalled();
      const sent = mock.sent[0];
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

      expect(mock.transport.send).toHaveBeenCalled();
      const sent = mock.sent[0];
      const parsed = JSON.parse(sent);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("getData");
      expect(parsed.params).toEqual({ query: "test" });
      expect(parsed.id).toBeDefined();
    });

    it("rejects when transport is closed", async () => {
      mock.setClosed(true);
      const promise = tunnel.request("getData", {});
      await expect(promise).rejects.toThrow("Transport is closed");
    });

    it("resolves when a matching response is received", async () => {
      const promise = tunnel.request("getInfo", { key: "val" });

      const sent = mock.sent[0];
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

  // ==========================================================================
  // addMethod
  // ==========================================================================

  describe("addMethod", () => {
    it("registers a handler that receives params and returns a result", async () => {
      const handler = vi.fn().mockResolvedValue({ computed: 42 });
      tunnel.addMethod("compute", handler);

      const request = buildJsonRpcRequest("compute", { input: 21 });
      tunnel.handleMessage(JSON.stringify(request));

      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledWith({ input: 21 });

      // Verify the response was sent back
      expect(mock.sent.length).toBeGreaterThanOrEqual(1);
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
