import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayFrame, ServerFrame } from "@shared/types/relay";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  frames: [] as ServerFrame[],
  query: vi.fn(),
  unsubscribe: vi.fn(),
  device: { id: "phone", name: "Phone", token_hash: "hash" },
  deleted: false,
  run: vi.fn(),
}));

vi.mock("ws", () => ({
  WebSocket: class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    on(event: string, handler: (...args: unknown[]) => void) {
      transport.handlers.set(event, handler);
    }
    send(data: string) {
      transport.frames.push(JSON.parse(data));
    }
    close() {}
  },
}));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: () => (transport.deleted ? undefined : transport.device),
      run: (...args: unknown[]) => {
        transport.run(sql, ...args);
        if (sql.startsWith("DELETE")) transport.deleted = true;
        return { changes: 1 };
      },
    }),
  }),
}));
vi.mock("../../../src/services/settings.service", () => ({
  getSetting: () => "test-relay",
}));
vi.mock("../../../src/services/query-engine", () => ({
  handleFrame: transport.query,
  removeSubs: transport.unsubscribe,
}));

import {
  disconnectFromRelay,
  ensureRelayConnected,
  getRelayStatus,
} from "../../../src/services/relay.service";
import { _clearAll, generatePairCode } from "../../../src/services/remote-auth.service";
import {
  addConnection,
  closeAll,
  getConnection,
  handleProtocolMessage,
} from "../../../src/services/ws.service";
import authRoutes from "../../../src/routes/remote-auth";

function receive(frame: RelayFrame): void {
  transport.handlers.get("message")!(JSON.stringify(frame));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _clearAll();
  transport.frames.length = 0;
  transport.deleted = false;
  ensureRelayConnected();
});

afterEach(() => {
  disconnectFromRelay();
  closeAll();
  vi.useRealTimers();
});

describe("relay pairing", () => {
  it("keeps the failed-attempt budget across pair sockets and unlocks after five minutes", () => {
    const { code } = generatePairCode();
    for (let i = 0; i < 10; i++) {
      receive({
        type: "pair_request",
        pairId: `attempt-${i}`,
        code: "WRONG CODE",
        deviceName: "Phone",
      });
    }
    receive({ type: "pair_request", pairId: "redial", code, deviceName: "Phone" });
    expect(transport.frames.at(-1)).toMatchObject({
      type: "pair_response",
      success: false,
      reason: "Too many failed attempts. Try again later.",
    });
    expect(transport.run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000);
    receive({
      type: "pair_request",
      pairId: "after-lockout",
      code: "WRONG CODE",
      deviceName: "Phone",
    });
    receive({ type: "pair_request", pairId: "corrected", code, deviceName: "Phone" });
    expect(transport.frames.at(-1)).toMatchObject({ type: "pair_response", success: true });
    expect(transport.run).toHaveBeenCalledOnce();
  });
});

describe("device revocation", () => {
  it("disconnects all of the device's transports and rejects buffered frames", async () => {
    const direct = { send: vi.fn(), close: vi.fn() };
    const other = { send: vi.fn(), close: vi.fn() };
    const directId = addConnection(direct, "phone");
    const otherId = addConnection(other, "another-phone");
    receive({ type: "client_connected", clientId: "relay-phone", deviceToken: "test-token" });
    receive({
      type: "data",
      clientId: "relay-phone",
      payload: JSON.stringify({ type: "q:subscribe" }),
    });
    const relayId = transport.query.mock.calls[0][0] as string;
    expect(getRelayStatus().clients).toBe(1);
    expect(transport.run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE paired_devices"),
      "hash"
    );

    const response = await authRoutes.request("/remote-auth/devices/phone", {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(response.status).toBe(200);
    expect(getConnection(directId)).toBeUndefined();
    expect(getConnection(relayId)).toBeUndefined();
    expect(direct.close).toHaveBeenCalledWith(4001, "Device access revoked");
    expect(transport.unsubscribe.mock.calls).toEqual([[directId], [relayId]]);
    expect(getRelayStatus().clients).toBe(0);
    expect(transport.frames.at(-1)).toEqual({
      type: "auth_response",
      clientId: "relay-phone",
      allowed: false,
      reason: "Device access revoked",
    });

    transport.query.mockClear();
    const frame = { type: "q:command", command: "sendMessage" };
    handleProtocolMessage(directId, frame);
    receive({ type: "data", clientId: "relay-phone", payload: JSON.stringify(frame) });
    expect(transport.query).not.toHaveBeenCalled();
    handleProtocolMessage(otherId, frame);
    expect(transport.query).toHaveBeenCalledWith(otherId, frame);
    expect(other.close).not.toHaveBeenCalled();

    receive({ type: "client_connected", clientId: "redial", deviceToken: "test-token" });
    expect(transport.frames.at(-1)).toMatchObject({
      type: "auth_response",
      clientId: "redial",
      allowed: false,
    });
  });
});
