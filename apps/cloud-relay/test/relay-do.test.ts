import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestDO,
  createMockWebSocket,
  registerServer,
  connectAndAuthClient,
  getSentMessages,
  getLastSent,
  TEST_ACCOUNT,
  type MockDOState,
  type MockWebSocket,
  type MockDOStorage,
} from "./mocks";

let relay: any;
let state: MockDOState;
let storage: MockDOStorage;

function expectNoStoredCredential(credential: string) {
  expect([...storage._data.keys()].filter((key) => key.startsWith("auth_token:"))).toEqual([]);
  // A credential written and deleted in one handler would still enter storage history.
  expect(JSON.stringify(vi.mocked(storage.put).mock.calls)).not.toContain(credential);
}

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
  it("keeps the route key only on the registered socket and clears it on keyless registration", async () => {
    const host = await registerServer(relay, state);
    const routeKey = "k".repeat(22);
    await relay.webSocketMessage(host, JSON.stringify({ type: "register", routeKey }));
    expect(host.deserializeAttachment()).toEqual({
      accountId: TEST_ACCOUNT,
      role: "host",
      routeKey,
    });
    expect(JSON.stringify(vi.mocked(storage.put).mock.calls)).not.toContain(routeKey);
    await relay.webSocketMessage(host, JSON.stringify({ type: "register" }));
    expect(host.deserializeAttachment()).toMatchObject({ accountId: TEST_ACCOUNT, role: "host" });
    expect((host.deserializeAttachment() as { routeKey?: string }).routeKey).toBeUndefined();
  });

  it("registration responds with registered; the ticket, not the frame, proved the host", async () => {
    const tunnelWs = await registerServer(relay, state);
    expect(storage._data.get("owner")).toBe(TEST_ACCOUNT);
    expect(storage._data.has("relayToken")).toBe(false);
    expect(getLastSent(tunnelWs)).toEqual({ type: "registered" });
  });

  it("stores serverName when provided", async () => {
    await registerServer(relay, state, { serverName: "My Machine" });
    expect(storage._data.get("serverName")).toBe("My Machine");
  });

  it("acknowledges registration before closing viewers even when scheduling the heartbeat fails", async () => {
    const viewer = createMockWebSocket(["client", "waiting"]);
    state._websockets.set(viewer, viewer._tags);
    storage.setAlarm.mockRejectedValueOnce(new Error("Cannot schedule heartbeat"));

    await expect(registerServer(relay, state)).rejects.toThrow("Cannot schedule heartbeat");
    const [host] = state.getWebSockets("tunnel");
    expect(await storage.get("tunnelRegistered")).toBe(true);
    expect(getSentMessages(host)).toEqual([{ type: "registered" }]);
    expect(host.send).toHaveBeenCalledBefore(viewer.close);
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

  it("forwards the pending viewer's credential to the host without storing it", async () => {
    const deviceToken = "online-viewer-grant";
    const { clientId } = await connectAndAuthClient(relay, state, { deviceToken });
    expect(getLastSent(tunnelWs)).toEqual({
      type: "client_connected",
      clientId,
      deviceToken,
      accountId: TEST_ACCOUNT,
    });
    expectNoStoredCredential(deviceToken);
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
    expect(await storage.get(`pending:${clientId}`)).toBeUndefined();
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

  it("auth_response can revoke an already authenticated client", async () => {
    const clientId = "revoked-phone";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);
    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );
    expect(getLastSent(clientWs)).toEqual({ type: "authenticated" });
    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({
        type: "auth_response",
        clientId,
        allowed: false,
        reason: "Device access revoked",
      })
    );
    expect(getLastSent(clientWs)).toEqual({
      type: "auth_failed",
      message: "Device access revoked",
    });
    expect(clientWs.close).toHaveBeenCalledWith(4003, "Device access revoked");
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
      accountId: TEST_ACCOUNT,
    });
  });

  it("returns the pairing grant to the viewer, who can authenticate with it", async () => {
    const pairId = "pair-1";
    const pairerWs = createMockWebSocket(["pairer", pairId]);
    state._websockets.set(pairerWs, ["pairer", pairId]);
    await storage.put(`pending:pair:${pairId}`, Date.now() + 30000);
    const deviceToken = "fresh-pairing-grant";

    await relay.webSocketMessage(
      tunnelWs,
      JSON.stringify({ type: "pair_response", pairId, success: true, deviceToken })
    );
    expect(getLastSent(pairerWs)).toEqual({ type: "pair_success", token: deviceToken });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Pairing complete");
    expectNoStoredCredential(deviceToken);

    const { clientId } = await connectAndAuthClient(relay, state, { deviceToken });
    expect(getLastSent(tunnelWs)).toEqual({
      type: "client_connected",
      clientId,
      deviceToken,
      accountId: TEST_ACCOUNT,
    });
    expectNoStoredCredential(deviceToken);
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
      message: "This computer is offline. Open Deus on it, then try again.",
    });
    expect(pairerWs.close).toHaveBeenCalledWith(1000, "Computer offline");
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
  it("removes one bounded batch of legacy credentials per alarm", async () => {
    await registerServer(relay, state);
    for (let i = 0; i < 129; i++) {
      await storage.put(`auth_token:${i}`, "legacy-fixture");
    }

    await relay.alarm();
    expect((await storage.list({ prefix: "auth_token:" })).size).toBe(1);
    expect(storage.list).toHaveBeenCalledWith({ prefix: "auth_token:", limit: 128 });

    await relay.alarm();
    expect((await storage.list({ prefix: "auth_token:" })).size).toBe(0);
    expect(await storage.get("owner")).toBe(TEST_ACCOUNT);
  });

  it("retries expired authentication without declaring the token invalid", async () => {
    const clientId = "expired-client";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() - 1000);

    await relay.alarm();

    expect(getLastSent(clientWs)).toEqual({
      type: "error",
      message: "Authentication timeout",
    });
    expect(clientWs.close).toHaveBeenCalledWith(1013, "Authentication timeout");
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

  it("reconnected server closes authenticated clients for fresh authorization", async () => {
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
    expect(messages).not.toContainEqual({ type: "server_connected" });
    expect(clientWs.close).toHaveBeenCalledWith(1012, "Host reconnected; authenticate again");
  });

  it("authenticates a viewer waiting through an outage only after it redials", async () => {
    const deviceToken = "returning-viewer-grant";
    const firstHost = await registerServer(relay, state);
    state._websockets.delete(firstHost);
    await relay.webSocketClose(firstHost, 1006, "network gone", false);
    expectNoStoredCredential(deviceToken);

    const waiting = await connectAndAuthClient(relay, state, { deviceToken });
    expect(getLastSent(waiting.clientWs)).toMatchObject({ type: "server_reconnecting" });
    expectNoStoredCredential(deviceToken);
    await relay.webSocketMessage(waiting.clientWs, JSON.stringify({ type: "ping", id: "waiting" }));
    expect(getLastSent(waiting.clientWs)).toEqual({ type: "pong", id: "waiting" });
    expectNoStoredCredential(deviceToken);

    const host = await registerServer(relay, state);
    expect(waiting.clientWs.close).toHaveBeenCalledWith(
      1012,
      "Host reconnected; authenticate again"
    );
    expect(getSentMessages(host)).toEqual([{ type: "registered" }]);
    expectNoStoredCredential(deviceToken);
    await relay.webSocketClose(
      waiting.clientWs,
      1012,
      "Host reconnected; authenticate again",
      true
    );
    expectNoStoredCredential(deviceToken);

    const redial = await connectAndAuthClient(relay, state, { deviceToken });
    expect(redial.clientId).not.toBe(waiting.clientId);
    expect(getLastSent(host)).toEqual({
      type: "client_connected",
      clientId: redial.clientId,
      accountId: TEST_ACCOUNT,
      deviceToken,
    });
    expectNoStoredCredential(deviceToken);
    await relay.webSocketMessage(
      host,
      JSON.stringify({ type: "auth_response", clientId: redial.clientId, allowed: true })
    );
    expect(getLastSent(redial.clientWs)).toEqual({ type: "authenticated" });
    expectNoStoredCredential(deviceToken);
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
  it("clears the disconnected viewer's authentication deadline", async () => {
    await registerServer(relay, state);

    const clientId = "client-dc";
    const clientWs = createMockWebSocket(["client", clientId]);
    state._websockets.set(clientWs, ["client", clientId]);
    await storage.put(`pending:${clientId}`, Date.now() + 5000);

    await relay.webSocketClose(clientWs, 1000, "bye", true);

    expect(storage._data.has(`pending:${clientId}`)).toBe(false);
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
  it("tells the assistant dialer the host is away without retaining its bearer", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const host = await registerServer(relay, state);
    state._websockets.delete(host);
    await relay.webSocketClose(host, 1006, "network gone", false);
    const bearer = "assistant.fixture.bearer";
    const { clientId, clientWs } = await connectAndAuthClient(relay, state, {
      deviceToken: bearer,
    });

    expect(getSentMessages(clientWs)).toEqual([
      {
        type: "server_reconnecting",
        serverDisconnectedAt: now,
        serverName: "Test Server",
      },
    ]);
    expect(await storage.get(`pending:${clientId}`)).toBe(now + 300_000);
    expectNoStoredCredential(bearer);
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
      type: "error",
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

// Client-originated liveness checks must cover the host when it is available,
// but preserve the authenticated/offline distinction while waiting for it.
describe("client heartbeat probes", () => {
  it("forwards an authorized probe through the host and returns its correlated pong", async () => {
    const tunnel = await registerServer(relay, state);
    const { clientId, clientWs } = await connectAndAuthClient(relay, state);
    await relay.webSocketMessage(
      tunnel,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );
    const probe = { type: "ping", id: "probe-1" };
    await relay.webSocketMessage(clientWs, JSON.stringify(probe));
    expect(getLastSent(tunnel)).toEqual({ type: "data", clientId, payload: JSON.stringify(probe) });
    await relay.webSocketMessage(
      tunnel,
      JSON.stringify({
        type: "data",
        clientId,
        payload: JSON.stringify({ type: "pong", id: "probe-1" }),
      })
    );
    expect(getLastSent(clientWs)).toEqual({ type: "pong", id: "probe-1" });
  });

  it("answers probes for pending clients without granting access or forwarding data", async () => {
    const tunnel = await registerServer(relay, state);
    const { clientId, clientWs } = await connectAndAuthClient(relay, state);
    const before = tunnel.send.mock.calls.length;
    await relay.webSocketMessage(clientWs, JSON.stringify({ type: "ping", id: "waiting" }));
    await relay.webSocketMessage(
      clientWs,
      JSON.stringify({ type: "q:mutate", action: "createSession", id: "forbidden", params: {} })
    );
    expect(getLastSent(clientWs)).toEqual({ type: "pong", id: "waiting" });
    expect(await storage.get(`pending:${clientId}`)).toBeDefined();
    expect(tunnel.send).toHaveBeenCalledTimes(before);
  });

  it("keeps an authorized client alive when its host disconnects", async () => {
    const tunnel = await registerServer(relay, state);
    const { clientId, clientWs } = await connectAndAuthClient(relay, state);
    await relay.webSocketMessage(
      tunnel,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );
    state._websockets.delete(tunnel);
    await relay.webSocketClose(tunnel, 1006, "network gone", false);
    expect(getLastSent(clientWs)).toMatchObject({ type: "server_reconnecting" });
    await relay.webSocketMessage(clientWs, JSON.stringify({ type: "ping", id: "offline" }));
    expect(getLastSent(clientWs)).toEqual({ type: "pong", id: "offline" });
  });
});

describe("host replacement authorization", () => {
  it("requires authenticated clients to reconnect and reauthorize with the new host", async () => {
    const tunnel = await registerServer(relay, state);
    const { clientId, clientWs } = await connectAndAuthClient(relay, state);
    await relay.webSocketMessage(
      tunnel,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );
    state._websockets.delete(tunnel);
    await relay.webSocketClose(tunnel, 1006, "outage", false);
    await registerServer(relay, state);
    expect(clientWs.close).toHaveBeenCalledWith(1012, "Host reconnected; authenticate again");
    expect(getSentMessages(clientWs)).not.toContainEqual({ type: "server_connected" });
    // A fresh client must remain pending until the replacement host allows it.
    const replacement = await connectAndAuthClient(relay, state, { clientId: "replacement" });
    await relay.webSocketMessage(
      replacement.clientWs,
      JSON.stringify({ type: "q:mutate", id: "blocked", action: "createSession", params: {} })
    );
    expect(await storage.get("pending:replacement")).toBeDefined();
  });

  it("closes viewers only when the replacement tunnel itself registers", async ({
    onTestFinished,
  }) => {
    const oldHost = await registerServer(relay, state);
    const admitted = await connectAndAuthClient(relay, state);
    await relay.webSocketMessage(
      oldHost,
      JSON.stringify({ type: "auth_response", clientId: admitted.clientId, allowed: true })
    );

    const host = createMockWebSocket([], null);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = createMockWebSocket([], null);
        1 = host;
      }
    );
    onTestFinished(() => vi.unstubAllGlobals());
    // Node's Response cannot represent the Workers 101 upgrade.
    vi.spyOn(relay, "upgraded").mockReturnValue(new Response(null));
    const admission = {
      accountId: TEST_ACCOUNT,
      machineId: "0123456789abcdef",
      role: "host",
      ticketId: crypto.randomUUID(),
      expiresAt: Date.now() + 60_000,
    };
    await relay.fetch(
      new Request("https://relay.internal/tunnel", {
        headers: { "x-deus-relay-admission": JSON.stringify(admission) },
      })
    );
    expect(state.getWebSockets("tunnel")).toEqual([oldHost, host]);
    expect(oldHost.close).toHaveBeenCalledWith(1000, "New tunnel connection");

    const deviceToken = "pending-replacement-grant";
    const pending = await connectAndAuthClient(relay, state, { deviceToken });
    expect(getSentMessages(host)).toEqual([]);
    await relay.webSocketMessage(
      oldHost,
      JSON.stringify({ type: "register", serverName: "Stale" })
    );
    expect(await storage.get("tunnelRegistered")).toBe(false);
    expect(await storage.get("serverName")).toBe("Test Server");
    expect(admitted.clientWs.close).not.toHaveBeenCalled();
    expect(pending.clientWs.close).not.toHaveBeenCalled();
    expectNoStoredCredential(deviceToken);

    await relay.webSocketMessage(host, JSON.stringify({ type: "register" }));
    expect(await storage.get("tunnelRegistered")).toBe(true);
    for (const ws of [admitted.clientWs, pending.clientWs]) {
      expect(ws.close).toHaveBeenCalledWith(1012, "Host reconnected; authenticate again");
    }
    // A peer can still send until it acknowledges our close.
    await relay.webSocketMessage(
      admitted.clientWs,
      JSON.stringify({ type: "q:request", id: "late" })
    );
    await relay.webSocketMessage(
      pending.clientWs,
      JSON.stringify({ type: "authenticate", token: deviceToken })
    );
    expect(getSentMessages(host)).toEqual([{ type: "registered" }]);
    expectNoStoredCredential(deviceToken);
  });
});

describe("closing tunnel lifecycle", () => {
  it("announces an outage even while the terminated socket remains in the Durable Object inventory", async () => {
    const tunnel = await registerServer(relay, state);
    const { clientId, clientWs } = await connectAndAuthClient(relay, state);
    await relay.webSocketMessage(
      tunnel,
      JSON.stringify({ type: "auth_response", clientId, allowed: true })
    );
    tunnel.readyState = 2;
    // Worker's close callback can still see this socket in getWebSockets().
    await relay.webSocketClose(tunnel, 1000, "Host shutdown", true);
    expect(tunnel.close).toHaveBeenCalledWith(1000, "Host shutdown");
    expect(getLastSent(clientWs)).toMatchObject({ type: "server_reconnecting" });
    expect(await storage.get("tunnelRegistered")).toBe(false);
  });
});
