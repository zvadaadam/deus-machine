import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_PROTOCOL, type RelayFrame, type ServerFrame } from "@shared/types/relay";

type Handler = (...args: unknown[]) => void;

const transport = vi.hoisted(() => ({
  sockets: [] as Array<{
    url: string;
    protocols: string[];
    handlers: Map<string, Handler>;
    frames: unknown[];
    readyState: number;
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    options?: { handshakeTimeout?: number };
  }>,
  query: vi.fn(),
  unsubscribe: vi.fn(),
  device: {
    id: "phone",
    name: "Phone",
    token_hash: "hash",
    account_id: "user_a",
    machine_id: "0123456789abcdef",
  } as {
    id: string;
    name: string;
    token_hash: string;
    account_id: string | null;
    machine_id: string | null;
  },
  deleted: false,
  run: vi.fn(),
  session: { cloudUrl: "https://cloud.test", sessionToken: "session-a", accountId: "user_a" } as {
    cloudUrl: string;
    sessionToken: string;
    accountId: string;
  } | null,
  remoteAccess: true,
  obtainHostTicket: vi.fn(),
  removed: new Set<string>(),
}));

vi.mock("ws", () => ({
  WebSocket: class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    handlers = new Map<string, Handler>();
    frames: unknown[] = [];
    close = vi.fn();
    // Like ws: aborting a handshake emits `close` (1006).
    terminate = vi.fn(() => this.handlers.get("close")?.(1006, ""));
    constructor(
      readonly url: string,
      readonly protocols: string[],
      readonly options?: { handshakeTimeout?: number }
    ) {
      transport.sockets.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    send(data: string) {
      this.frames.push(JSON.parse(data));
    }
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
  getSetting: (key: string) =>
    key === "remote_access_enabled"
      ? transport.remoteAccess
      : key === "server_name"
        ? "Studio"
        : null,
}));
vi.mock("../../../src/services/remote-machine.service", () => ({
  currentAccountSession: () => transport.session,
  getMachineId: () => null,
  obtainHostTicket: transport.obtainHostTicket,
  isMachineRemoved: (accountId: string) => transport.removed.has(accountId),
  forgetRemovedMachine: (accountId: string) => transport.removed.delete(accountId),
  MachineRemovedError: class MachineRemovedError extends Error {
    constructor() {
      super("This computer was removed from your Deus account.");
    }
  },
}));
vi.mock("../../../src/services/query-engine", () => ({
  handleFrame: transport.query,
  removeSubs: transport.unsubscribe,
}));

import {
  disconnectFromRelay,
  getRelayStatus,
  reconcileRelay,
} from "../../../src/services/relay.service";
import { _clearAll, generatePairCode } from "../../../src/services/remote-auth.service";
import {
  addConnection,
  closeAll,
  getConnection,
  handleProtocolMessage,
} from "../../../src/services/ws.service";
import authRoutes from "../../../src/routes/remote-auth";
import { MachineRemovedError } from "../../../src/services/remote-machine.service";

const MACHINE = "0123456789abcdef";
const tunnel = () => transport.sockets.at(-1)!;
const frames = () => tunnel().frames as ServerFrame[];

function receive(frame: RelayFrame, socket = tunnel()): void {
  socket.handlers.get("message")!(JSON.stringify(frame));
}

async function openTunnel(): Promise<void> {
  reconcileRelay();
  await vi.waitFor(() => expect(transport.sockets.length).toBeGreaterThan(0));
  tunnel().handlers.get("open")!();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _clearAll();
  transport.sockets.length = 0;
  transport.deleted = false;
  transport.remoteAccess = true;
  transport.device = {
    id: "phone",
    name: "Phone",
    token_hash: "hash",
    account_id: "user_a",
    machine_id: MACHINE,
  };
  transport.removed.clear();
  transport.session = {
    cloudUrl: "https://cloud.test",
    sessionToken: "session-a",
    accountId: "user_a",
  };
  transport.obtainHostTicket.mockImplementation(async (session: { accountId: string }) => ({
    machineId: MACHINE,
    ticket: `ticket-for-${session.accountId}`,
  }));
  await openTunnel();
});

afterEach(() => {
  disconnectFromRelay();
  closeAll();
  vi.useRealTimers();
});

describe("account-bound tunnel", () => {
  it("dials with the account's host ticket and registers by name only", () => {
    expect(transport.obtainHostTicket).toHaveBeenCalledWith(
      transport.session,
      "Studio",
      expect.any(AbortSignal)
    );
    expect(tunnel().url).toBe(`wss://relay.deusmachine.ai/api/servers/${MACHINE}/tunnel`);
    expect(tunnel().protocols).toEqual([RELAY_PROTOCOL, "ticket-for-user_a"]);
    expect(frames()).toEqual([{ type: "register", serverName: "Studio" }]);
    expect(getRelayStatus()).toMatchObject({
      state: "connected",
      serverId: MACHINE,
      accountId: "user_a",
    });
  });

  it("waits for a signed-in account and closes when it signs out", () => {
    transport.session = null;
    reconcileRelay();
    expect(tunnel().close).toHaveBeenCalled();
    expect(getRelayStatus()).toMatchObject({ state: "signed_out", serverId: null });

    transport.sockets.length = 0;
    reconcileRelay();
    expect(transport.sockets).toHaveLength(0);
  });

  it("replaces the tunnel when the desktop switches accounts; the old socket's events are ignored", async () => {
    const first = tunnel();
    receive({
      type: "client_connected",
      clientId: "a-phone",
      deviceToken: "t",
      accountId: "user_a",
    });
    expect(getRelayStatus().clients).toBe(1);

    transport.session = {
      cloudUrl: "https://cloud.test",
      sessionToken: "session-b",
      accountId: "user_b",
    };
    reconcileRelay();
    expect(first.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    const second = tunnel();
    expect(second.protocols).toEqual([RELAY_PROTOCOL, "ticket-for-user_b"]);
    expect(getRelayStatus()).toMatchObject({ accountId: "user_b", clients: 0 });

    // The first socket closing late must not tear down its replacement.
    first.handlers.get("close")!(1000, "");
    second.handlers.get("open")!();
    expect(getRelayStatus().state).toBe("connected");
  });

  it("abandons a dial still waiting on Deus Cloud when the account switches or signs out", async () => {
    disconnectFromRelay();
    transport.sockets.length = 0;
    const signals: AbortSignal[] = [];
    let issue!: (ticket: { machineId: string; ticket: string }) => void;
    transport.obtainHostTicket.mockImplementationOnce(
      (_session: unknown, _name: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          signals.push(signal);
          issue = resolve;
        })
    );
    reconcileRelay();
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    transport.session = {
      cloudUrl: "https://cloud.test",
      sessionToken: "session-b",
      accountId: "user_b",
    };
    reconcileRelay();
    expect(signals[0].aborted).toBe(true);
    // Account A's ticket arriving late must not open a tunnel for it.
    issue({ machineId: MACHINE, ticket: "late-ticket-for-a" });
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    expect(tunnel().protocols).toEqual([RELAY_PROTOCOL, "ticket-for-user_b"]);

    transport.obtainHostTicket.mockImplementationOnce(
      (_session: unknown, _name: string, signal: AbortSignal) =>
        new Promise(() => signals.push(signal))
    );
    tunnel().handlers.get("close")!(1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    transport.session = null;
    reconcileRelay();
    expect(signals[1].aborted).toBe(true);
    expect(getRelayStatus().state).toBe("signed_out");
  });

  it("keeps the tunnel through a session renewal for the same account", () => {
    transport.session = { ...transport.session!, sessionToken: "session-a-renewed" };
    reconcileRelay();
    expect(transport.sockets).toHaveLength(1);
    expect(tunnel().close).not.toHaveBeenCalled();
  });

  it("retries with a fresh ticket when Deus Cloud is unavailable", async () => {
    disconnectFromRelay();
    transport.sockets.length = 0;
    transport.obtainHostTicket.mockRejectedValueOnce(new Error("Deus Cloud answered 503"));
    reconcileRelay();
    await vi.waitFor(() =>
      expect(getRelayStatus()).toMatchObject({
        state: "connecting",
        error: "Deus Cloud answered 503",
      })
    );
    expect(transport.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.obtainHostTicket).toHaveBeenCalledTimes(3);
    expect(transport.sockets).toHaveLength(1);
  });
});

describe("tunnel failures", () => {
  it("ends a refused handshake and redials with a fresh ticket", async () => {
    expect(tunnel().options).toEqual({ handshakeTimeout: 15_000 });
    const refused = tunnel();
    refused.handlers.get("unexpected-response")!({}, { statusCode: 401, resume: vi.fn() });
    expect(refused.terminate).toHaveBeenCalledOnce();
    expect(getRelayStatus()).toMatchObject({
      state: "connecting",
      error: "The relay refused this computer (401)",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.sockets).toHaveLength(2);
    expect(transport.obtainHostTicket).toHaveBeenCalledTimes(2);
  });

  it("backs off hard when another Deus app on this computer takes the tunnel", async () => {
    tunnel().handlers.get("close")!(1000, Buffer.from("New tunnel connection"));
    expect(getRelayStatus().error).toMatch(/Another Deus app/);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(transport.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.sockets).toHaveLength(2);
  });

  it("stays off once the account removed this computer, until remote access is turned on", async () => {
    transport.obtainHostTicket.mockImplementationOnce(async () => {
      transport.removed.add("user_a");
      throw new MachineRemovedError();
    });
    tunnel().handlers.get("close")!(1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getRelayStatus()).toMatchObject({ state: "removed", serverId: null });
    await vi.advanceTimersByTimeAsync(120_000);
    reconcileRelay();
    expect(transport.sockets).toHaveLength(1);

    reconcileRelay({ restart: true });
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    expect(transport.removed.has("user_a")).toBe(false);
  });
});

describe("account-bound device grants", () => {
  it("admits a grant paired under the tunnel's account", () => {
    receive({ type: "client_connected", clientId: "c1", deviceToken: "t", accountId: "user_a" });
    expect(frames().at(-1)).toEqual({ type: "auth_response", clientId: "c1", allowed: true });
  });

  it.each([
    ["paired before account binding", null, "user_a"],
    ["paired under another account", "user_b", "user_a"],
    ["presented by another account", "user_a", "user_b"],
  ])("rejects a grant %s", (_label, grantAccount, viewerAccount) => {
    transport.device = { ...transport.device, account_id: grantAccount };
    receive({
      type: "client_connected",
      clientId: "c1",
      deviceToken: "t",
      accountId: viewerAccount as string,
    });
    expect(frames().at(-1)).toMatchObject({
      type: "auth_response",
      clientId: "c1",
      allowed: false,
    });
  });

  it("binds a relay pairing to the relay-verified account", () => {
    const { code } = generatePairCode();
    receive({ type: "pair_request", pairId: "p1", code, deviceName: "Phone", accountId: "user_a" });
    expect(frames().at(-1)).toMatchObject({ type: "pair_response", pairId: "p1", success: true });
    const insert = transport.run.mock.calls.find(([sql]) => String(sql).includes("INSERT"))!;
    expect(insert.slice(-2)).toEqual(["user_a", MACHINE]);
  });

  it("retires grants made for a machine the account later removed", () => {
    transport.device = { ...transport.device, machine_id: "fedcba9876543210" };
    receive({ type: "client_connected", clientId: "c1", deviceToken: "t", accountId: "user_a" });
    expect(frames().at(-1)).toMatchObject({ type: "auth_response", allowed: false });
  });

  it("refuses a pairing for an account this computer is not signed in to", () => {
    const { code } = generatePairCode();
    receive({ type: "pair_request", pairId: "p1", code, deviceName: "Phone", accountId: "user_b" });
    expect(frames().at(-1)).toMatchObject({ type: "pair_response", success: false });
    expect(transport.run).not.toHaveBeenCalled();
  });
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
        accountId: "user_a",
      });
    }
    receive({
      type: "pair_request",
      pairId: "redial",
      code,
      deviceName: "Phone",
      accountId: "user_a",
    });
    expect(frames().at(-1)).toMatchObject({
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
      accountId: "user_a",
    });
    receive({
      type: "pair_request",
      pairId: "corrected",
      code,
      deviceName: "Phone",
      accountId: "user_a",
    });
    expect(frames().at(-1)).toMatchObject({ type: "pair_response", success: true });
    expect(transport.run).toHaveBeenCalledOnce();
  });
});

describe("device revocation", () => {
  it("disconnects all of the device's transports and rejects buffered frames", async () => {
    const direct = { send: vi.fn(), close: vi.fn() };
    const other = { send: vi.fn(), close: vi.fn() };
    const directId = addConnection(direct, "phone");
    const otherId = addConnection(other, "another-phone");
    receive({
      type: "client_connected",
      clientId: "relay-phone",
      deviceToken: "test-token",
      accountId: "user_a",
    });
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
    expect(frames().at(-1)).toEqual({
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

    receive({
      type: "client_connected",
      clientId: "redial",
      deviceToken: "test-token",
      accountId: "user_a",
    });
    expect(frames().at(-1)).toMatchObject({
      type: "auth_response",
      clientId: "redial",
      allowed: false,
    });
  });
});

describe("relay client liveness", () => {
  it("answers the probe through a virtual authenticated connection", () => {
    receive({
      type: "client_connected",
      clientId: "phone",
      deviceToken: "test-token",
      accountId: "user_a",
    });
    receive({
      type: "data",
      clientId: "phone",
      payload: JSON.stringify({ type: "ping", id: "probe" }),
    });
    expect(frames().at(-1)).toEqual({
      type: "data",
      clientId: "phone",
      payload: JSON.stringify({ type: "pong", id: "probe" }),
    });
    expect(transport.query).not.toHaveBeenCalled();
  });
});
