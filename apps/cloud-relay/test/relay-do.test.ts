import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestDO,
  createMockWebSocket,
  registerServer,
  connectAndAuthClient,
  getSentMessages,
  getLastSent,
  type MockDOState,
  type MockWebSocket,
  type MockDOStorage,
} from "./mocks";

let relay: any;
let state: MockDOState;
let storage: MockDOStorage;

beforeEach(async () => {
  vi.resetModules();
  const harness = await createTestDO();
  relay = harness.relay;
  state = harness.state;
  storage = harness.storage;
});

// ============================================================================
// Server Tunnel Registration
// ============================================================================

describe("server tunnel registration", () => {
  it("first registration stores relayToken and responds with registered", async () => {
    const tunnelWs = await registerServer(relay, state);
    expect(storage._data.get("relayToken")).toBe("tok_test");
    expect(getLastSent(tunnelWs)).toEqual({ type: "registered" });
  });

  it("stores serverName when provided", async () => {
    await registerServer(relay, state, { serverName: "My Machine" });
    expect(storage._data.get("serverName")).toBe("My Machine");
  });

  it("sets tunnelRegistered to true after register", async () => {
    await registerServer(relay, state);
    expect(storage._data.get("tunnelRegistered")).toBe(true);
  });

  it("rejects registration with mismatched token", async () => {
    // First registration sets the token
    await registerServer(relay, state, { relayToken: "correct_token" });

    // Second registration with wrong token
    const badTunnelWs = createMockWebSocket(["tunnel"]);
    state._websockets.set(badTunnelWs, ["tunnel"]);

    await relay.webSocketMessage(
      badTunnelWs,
      JSON.stringify({ type: "register", serverId: "test1234", relayToken: "wrong_token" })
    );

    expect(getLastSent(badTunnelWs)).toEqual({ type: "error", message: "Invalid relay token" });
    expect(badTunnelWs.close).toHaveBeenCalledWith(4003, "Invalid relay token");
  });

  it("accepts registration with matching token", async () => {
    await registerServer(relay, state, { relayToken: "tok_abc" });

    const tunnelWs2 = createMockWebSocket(["tunnel"]);
    state._websockets.set(tunnelWs2, ["tunnel"]);

    await relay.webSocketMessage(
      tunnelWs2,
      JSON.stringify({ type: "register", serverId: "test1234", relayToken: "tok_abc" })
    );

    expect(getLastSent(tunnelWs2)).toEqual({ type: "registered" });
  });
});

// ============================================================================
// Client Auth Flow
// ============================================================================

describe("client auth flow", () => {
  let tunnelWs: MockWebSocket;

  beforeEach(async () => {
    tunnelWs = await registerServer(relay, state);
  });

  it("pending client authenticate forwards client_connected to tunnel", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "authenticate", token: "dev_tok_1" })
    );

    // Should forward to tunnel
    const tunnelMessages = getSentMessages(tunnelWs);
    const clientConnected = tunnelMessages.find(
      (m: any) => m.type === "client_connected" && m.clientId === clientId
    );
    expect(clientConnected).toEqual({
      type: "client_connected",
      clientId,
      deviceToken: "dev_tok_1",
    });
  });

  it("stores auth token for re-forwarding on reconnect", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "authenticate", token: "dev_tok_1" })
    );

    expect(storage._data.get(`auth_token:${clientId}`)).toBe("dev_tok_1");
  });

  it("non-authenticate message from pending client is ignored", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(clientWs, JSON.stringify({ type: "data", content: "hello" }));

    // Tunnel should not receive any data message
    const tunnelMessages = getSentMessages(tunnelWs);
    const dataMessages = tunnelMessages.filter((m: any) => m.type === "data");
    expect(dataMessages).toHaveLength(0);
  });

  it("auth_response allowed=true sends authenticated to client", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );

    expect(getLastSent(clientWs)).toEqual({ type: "authenticated" });
  });

  it("auth_response allowed=true clears pending and auth_token", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);
    await storage.put(`auth_token:${clientId}`, "tok");

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );

    expect(storage._data.has(`pending:${clientId}`)).toBe(false);
    expect(storage._data.has(`auth_token:${clientId}`)).toBe(false);
  });

  it("auth_response allowed=false sends auth_failed and closes client", async () => {
    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "auth_response", clientId, allowed: false, reason: "Bad token" })
    );

    expect(getLastSent(clientWs)).toEqual({ type: "auth_failed", message: "Bad token" });
    expect(clientWs.close).toHaveBeenCalledWith(4003, "Bad token");
  });

  it("auth_response is ignored when tunnel is not registered", async () => {
    // Reset tunnelRegistered
    await storage.put("tunnelRegistered", false);

    const clientId = "client-abc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );

    // Client should NOT receive authenticated
    expect(getSentMessages(clientWs)).toHaveLength(0);
  });
});

// ============================================================================
// Data Forwarding
// ============================================================================

describe("data forwarding", () => {
  let tunnelWs: MockWebSocket;

  beforeEach(async () => {
    tunnelWs = await registerServer(relay, state);
  });

  it("authenticated client message is forwarded to tunnel as data frame", async () => {
    const clientId = "client-fwd";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    // No pending entry = authenticated

    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "q:subscribe", id: "sub_1", resource: "workspaces" })
    );

    const tunnelMessages = getSentMessages(tunnelWs);
    const dataMsg = tunnelMessages.find(
      (m: any) => m.type === "data" && m.clientId === clientId
    ) as any;
    expect(dataMsg).toBeDefined();
    expect(JSON.parse(dataMsg.payload)).toEqual({
      type: "q:subscribe",
      id: "sub_1",
      resource: "workspaces",
    });
  });

  it("server data frame is forwarded verbatim to correct client", async () => {
    const clientId = "client-fwd";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "data",
        clientId,
        payload: '{"type":"q:snapshot","id":"sub_1","data":[]}',
      })
    );

    // Client receives the raw payload string
    expect(clientWs.send).toHaveBeenCalledWith('{"type":"q:snapshot","id":"sub_1","data":[]}');
  });

  it("server data for pending client is silently dropped", async () => {
    const clientId = "client-pending";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "data", clientId, payload: '{"msg":"hello"}' })
    );

    expect(clientWs.send).not.toHaveBeenCalled();
  });

  it("server data for non-existent client does not crash", async () => {
    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "data", clientId: "ghost", payload: '{"msg":"hello"}' })
    );
    // No error thrown
  });

  it("server data is ignored when tunnel is not registered", async () => {
    await storage.put("tunnelRegistered", false);

    const clientId = "client-fwd";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "data", clientId, payload: '{"msg":"hello"}' })
    );

    expect(clientWs.send).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Pairing Flow
// ============================================================================

describe("pairing flow", () => {
  let tunnelWs: MockWebSocket;

  beforeEach(async () => {
    tunnelWs = await registerServer(relay, state);
  });

  it("pairer sends pair_request which is forwarded to tunnel", async () => {
    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      pairerWs,
      JSON.stringify({ type: "pair_request", code: "EAGLE", deviceName: "iPad" })
    );

    const tunnelMessages = getSentMessages(tunnelWs);
    const pairReq = tunnelMessages.find((m: any) => m.type === "pair_request") as any;
    expect(pairReq).toEqual({
      type: "pair_request",
      pairId,
      code: "EAGLE",
      deviceName: "iPad",
    });
  });

  it("server pair_response success sends pair_success to pairer", async () => {
    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "pair_response",
        pairId,
        success: true,
        deviceToken: "new_dev_tok",
      })
    );

    expect(getLastSent(pairerWs)).toEqual({ type: "pair_success", token: "new_dev_tok" });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Pairing complete");
  });

  it("server pair_response failure sends pair_failed to pairer", async () => {
    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "pair_response",
        pairId,
        success: false,
        reason: "Invalid code",
      })
    );

    expect(getLastSent(pairerWs)).toEqual({ type: "pair_failed", message: "Invalid code" });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Pairing complete");
  });

  it("pair_response cleans up pending:pair storage", async () => {
    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "pair_response",
        pairId,
        success: true,
        deviceToken: "tok",
      })
    );

    expect(storage._data.has(`pending:pair:${pairId}`)).toBe(false);
  });

  it("pairer request when server offline sends pair_failed", async () => {
    // Remove tunnel
    state._websockets.clear();

    const pairId = "pair-2";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      pairerWs,
      JSON.stringify({ type: "pair_request", code: "CLOUD", deviceName: "Browser" })
    );

    expect(getLastSent(pairerWs)).toEqual({
      type: "pair_failed",
      message: "Server is offline",
    });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Server offline");
  });

  it("pair_response is ignored when tunnel is not registered", async () => {
    await storage.put("tunnelRegistered", false);

    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "pair_response",
        pairId,
        success: true,
        deviceToken: "tok",
      })
    );

    expect(getSentMessages(pairerWs)).toHaveLength(0);
  });
});

// ============================================================================
// Alarm — Timeouts and Heartbeat
// ============================================================================

describe("alarm", () => {
  it("rejects clients whose auth deadline has expired", async () => {
    const clientId = "expired-client";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() - 1000);

    await relay.alarm();

    expect(getLastSent(clientWs)).toEqual({
      type: "auth_failed",
      message: "Authentication timeout",
    });
    expect(clientWs.close).toHaveBeenCalledWith(4003, "Authentication timeout");
    expect(storage._data.has(`pending:${clientId}`)).toBe(false);
  });

  it("does not reject clients whose deadline has not passed", async () => {
    const clientId = "valid-client";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 60000);

    await relay.alarm();

    expect(getSentMessages(clientWs)).toHaveLength(0);
    expect(storage._data.has(`pending:${clientId}`)).toBe(true);
  });

  it("rejects pairers whose deadline has expired", async () => {
    const pairId = "expired-pair";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() - 1000);

    await relay.alarm();

    expect(getLastSent(pairerWs)).toEqual({
      type: "pair_failed",
      message: "Pairing timed out",
    });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Pairing timed out");
  });

  it("sends ping to tunnel for heartbeat", async () => {
    const tunnelWs = createMockWebSocket(["tunnel"]);
    state._websockets.set(tunnelWs, ["tunnel"]);

    await relay.alarm();

    const messages = getSentMessages(tunnelWs);
    expect(messages).toContainEqual({ type: "ping" });
  });

  it("schedules next alarm", async () => {
    const tunnelWs = createMockWebSocket(["tunnel"]);
    state._websockets.set(tunnelWs, ["tunnel"]);

    await relay.alarm();

    expect(storage.setAlarm).toHaveBeenCalled();
    expect(storage._alarmTime).toBeGreaterThan(Date.now());
  });
});

// ============================================================================
// Server Disconnect and Reconnection
// ============================================================================

describe("server disconnect and reconnection", () => {
  it("server disconnect sets tunnelRegistered to false", async () => {
    const tunnelWs = await registerServer(relay, state);

    // Remove tunnel from registry to simulate disconnect
    state._websockets.delete(tunnelWs);
    await relay.webSocketClose(tunnelWs, 1000, "gone", true);

    expect(storage._data.get("tunnelRegistered")).toBe(false);
  });

  it("server disconnect stores serverDisconnectedAt", async () => {
    const tunnelWs = await registerServer(relay, state);

    state._websockets.delete(tunnelWs);
    await relay.webSocketClose(tunnelWs, 1000, "gone", true);

    expect(storage._data.get("serverDisconnectedAt")).toBeTypeOf("number");
  });

  it("server disconnect notifies authenticated clients with server_reconnecting", async () => {
    const tunnelWs = await registerServer(relay, state);

    // Add an authenticated client
    const clientId = "client-1";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    // Disconnect server
    state._websockets.delete(tunnelWs);
    await relay.webSocketClose(tunnelWs, 1000, "gone", true);

    const lastMsg = getLastSent(clientWs) as any;
    expect(lastMsg.type).toBe("server_reconnecting");
    expect(lastMsg.serverDisconnectedAt).toBeTypeOf("number");
  });

  it("disconnect is no-op if another tunnel is already active", async () => {
    const tunnelWs1 = await registerServer(relay, state);

    // Add a second tunnel (simulating replacement)
    const tunnelWs2 = createMockWebSocket(["tunnel"]);
    state._websockets.set(tunnelWs2, ["tunnel"]);

    // Old tunnel close fires — should be a no-op
    await relay.webSocketClose(tunnelWs1, 1000, "replaced", true);

    // tunnelRegistered should still be true (not reset)
    expect(storage._data.get("tunnelRegistered")).toBe(true);
  });

  it("reconnected server notifies authenticated clients with server_connected", async () => {
    const tunnelWs1 = await registerServer(relay, state);

    // Add authenticated client
    const clientId = "client-1";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    // Disconnect
    state._websockets.delete(tunnelWs1);
    await relay.webSocketClose(tunnelWs1, 1000, "gone", true);

    // Reconnect
    const tunnelWs2 = await registerServer(relay, state);

    const messages = getSentMessages(clientWs);
    expect(messages).toContainEqual({ type: "server_connected" });
  });

  it("reconnection re-forwards pending clients stored auth tokens", async () => {
    const tunnelWs1 = await registerServer(relay, state);

    // Add a pending client with stored auth token
    const clientId = "client-pending";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 300000);
    await storage.put(`auth_token:${clientId}`, "saved_token");

    // Disconnect
    state._websockets.delete(tunnelWs1);
    await relay.webSocketClose(tunnelWs1, 1000, "gone", true);

    // Reconnect
    const tunnelWs2 = await registerServer(relay, state);

    const tunnelMessages = getSentMessages(tunnelWs2);
    const reForwarded = tunnelMessages.find(
      (m: any) => m.type === "client_connected" && m.clientId === clientId
    );
    expect(reForwarded).toEqual({
      type: "client_connected",
      clientId,
      deviceToken: "saved_token",
    });
  });

  it("reconnection clears serverDisconnectedAt", async () => {
    const tunnelWs1 = await registerServer(relay, state);

    state._websockets.delete(tunnelWs1);
    await relay.webSocketClose(tunnelWs1, 1000, "gone", true);

    expect(storage._data.has("serverDisconnectedAt")).toBe(true);

    await registerServer(relay, state);

    expect(storage._data.has("serverDisconnectedAt")).toBe(false);
  });
});

// ============================================================================
// Client Disconnect
// ============================================================================

describe("client disconnect", () => {
  it("cleans up pending and auth_token from storage", async () => {
    const tunnelWs = await registerServer(relay, state);

    const clientId = "client-dc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);
    await storage.put(`auth_token:${clientId}`, "tok");

    await relay.webSocketClose(clientWs, 1000, "bye", true);

    expect(storage._data.has(`pending:${clientId}`)).toBe(false);
    expect(storage._data.has(`auth_token:${clientId}`)).toBe(false);
  });

  it("notifies tunnel with client_disconnected", async () => {
    const tunnelWs = await registerServer(relay, state);

    const clientId = "client-dc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    await relay.webSocketClose(clientWs, 1000, "bye", true);

    const tunnelMessages = getSentMessages(tunnelWs);
    expect(tunnelMessages).toContainEqual({
      type: "client_disconnected",
      clientId,
    });
  });

  it("client disconnect when tunnel is down does not crash", async () => {
    const clientId = "client-dc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    // No tunnel registered — should not throw
    await relay.webSocketClose(clientWs, 1000, "bye", true);
  });
});

// ============================================================================
// WebSocket Message Dispatch (edge cases)
// ============================================================================

describe("webSocketMessage dispatch", () => {
  it("non-JSON messages are silently ignored", async () => {
    const tunnelWs = await registerServer(relay, state);
    // Should not throw
    await relay.webSocketMessage(tunnelWs, "not valid json {{{");
  });

  it("invalid server frames are silently ignored", async () => {
    const tunnelWs = await registerServer(relay, state);
    await relay.webSocketMessage(tunnelWs, JSON.stringify({ type: "invalid_type", foo: "bar" }));
    // No crash
  });

  it("pong from server is silently consumed", async () => {
    const tunnelWs = await registerServer(relay, state);
    await relay.webSocketMessage(tunnelWs, JSON.stringify({ type: "pong" }));
    // No crash, no side effects
  });
});

// ============================================================================
// Client auth when server is offline
// ============================================================================

describe("client auth when server is offline", () => {
  it("extends deadline and sends server_reconnecting when tunnel is down", async () => {
    // Register then disconnect
    const tunnelWs = await registerServer(relay, state);
    state._websockets.delete(tunnelWs);
    await relay.webSocketClose(tunnelWs, 1000, "gone", true);

    const clientId = "offline-client";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "authenticate", token: "dev_tok" })
    );

    // Should get server_reconnecting
    const lastMsg = getLastSent(clientWs) as any;
    expect(lastMsg.type).toBe("server_reconnecting");

    // Deadline should be extended (OFFLINE_WAIT_MS = 300000)
    const newDeadline = storage._data.get(`pending:${clientId}`) as number;
    expect(newDeadline).toBeGreaterThan(Date.now() + 200000);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("safeSend catches exceptions from ws.send()", async () => {
    const tunnelWs = await registerServer(relay, state);

    const clientId = "broken-client";
    const clientWs = createMockWebSocket(["client", clientId]);
    clientWs.send = vi.fn(() => {
      throw new Error("WebSocket closed");
    });
    clientWs._sentMessages = []; // reset since send is replaced
    state._websockets.set(clientWs, ["client", clientId]);

    // Should not throw
    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "data", clientId, payload: '{"msg":"test"}' })
    );
  });

  it("getPendingClients filters out pending:pair: entries", async () => {
    const tunnelWs = await registerServer(relay, state);

    const clientId = "real-client";
    await storage.put(`pending:${clientId}`, Date.now() - 1000);
    await storage.put("pending:pair:some-pair", Date.now() - 1000);

    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);

    // Alarm should only reject the client, not treat the pair as a client
    await relay.alarm();

    expect(getLastSent(clientWs)).toEqual({
      type: "auth_failed",
      message: "Authentication timeout",
    });
    // pair entry should still have been handled separately
  });

  it("multiple clients can be pending simultaneously", async () => {
    const tunnelWs = await registerServer(relay, state);

    const ids = ["c1", "c2", "c3"];
    for (const id of ids) {
      const ws = createMockWebSocket(["client", id]);
      state._websockets.set(ws, ["client", id]);
      await storage.put(`pending:${id}`, Date.now() + 5000);
    }

    // Each can authenticate independently
    for (const id of ids) {
      await relay.webSocketMessage(
        tunnelWs,
        JSON.stringify({ type: "auth_response", clientId: id, allowed: true })
      );
    }

    for (const id of ids) {
      expect(storage._data.has(`pending:${id}`)).toBe(false);
    }
  });
});
