import { mkdtemp, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { decodeChunk, MAX_CHUNK_BYTES } from "@shared/tunnel";
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
  opened: vi.fn<(file: FileHandle) => void>(),
  binary: vi.fn<(data: Uint8Array, done: (error?: Error) => void) => void>(),
  unsubscribe: vi.fn(),
  /** The live reads told to answer again (`invalidate`): how a device list change reaches clients. */
  invalidate: vi.fn(),
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
  /** What the assistants service decides for an access token (verified there, see assistants.test.ts). */
  admitAssistant: vi.fn(),
}));

vi.mock("node:fs/promises", async (original) => {
  const disk = await original<typeof import("node:fs/promises")>();
  return {
    ...disk,
    open: async (...args: Parameters<typeof disk.open>) => {
      const descriptor = await disk.open(...args);
      transport.opened(descriptor);
      return descriptor;
    },
  };
});

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
    send(data: string | Uint8Array, options?: { binary: boolean }, done?: (error?: Error) => void) {
      if (options?.binary && typeof data !== "string" && done) {
        transport.binary(data, done);
        return;
      }
      // A Buffer without binary:false becomes a binary WebSocket message.
      if (Buffer.isBuffer(data) && options?.binary !== false) throw new Error("Expected text");
      if (Buffer.byteLength(data) > 32 * 1024 * 1024) {
        this.close(1009, "Message too big");
        return;
      }
      this.frames.push(JSON.parse(String(data)));
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
// Only admission is stood in for: which credential is an assistant's is the real check.
vi.mock("../../../src/services/assistants", () => ({ admitAssistant: transport.admitAssistant }));
vi.mock("../../../src/services/query-engine", () => ({
  handleFrame: transport.query,
  removeSubs: transport.unsubscribe,
  invalidate: transport.invalidate,
}));

import {
  disconnectFromRelay,
  getRelayStatus,
  reconcileRelay,
} from "../../../src/services/relay.service";
import {
  _clearAll,
  generatePairCode,
  revokeDevice,
} from "../../../src/services/remote-auth.service";
import {
  addConnection,
  closeAll,
  getConnection,
  handleProtocolMessage,
  sendFrame,
} from "../../../src/services/ws.service";
import { MachineRemovedError } from "../../../src/services/remote-machine.service";
import { AssistantRefusedError } from "../../../src/services/assistants/token";
import { connectedDeviceIds } from "../../../src/services/ws.service";
import { resolveBrowserFile } from "../../../src/services/browser-files";
import { fileHandles } from "../../../src/services/relay-file-handles";

const MACHINE = "0123456789abcdef";
const tunnel = () => transport.sockets.at(-1)!;
const frames = () => tunnel().frames as ServerFrame[];

async function recording() {
  const dir = await mkdtemp(path.join(tmpdir(), "deus-tunnel-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "recording.mp4");
  await writeFile(file, "abc");
  return resolveBrowserFile({ kind: "recording", path: file });
}

function receive(frame: RelayFrame, socket = tunnel()): void {
  socket.handlers.get("message")!(JSON.stringify(frame));
}

/** The connection the relay client's frames reach, as the query engine sees it. */
function connectionOf(clientId: string) {
  receive({ type: "data", clientId, payload: JSON.stringify({ type: "q:request", id: "r" }) });
  const [connectionId] = transport.query.mock.calls.at(-1) as [string];
  return getConnection(connectionId);
}

async function openTunnel(): Promise<void> {
  reconcileRelay();
  await vi.waitFor(() => expect(transport.sockets.length).toBeGreaterThan(0));
  tunnel().handlers.get("open")!();
  receive({ type: "registered" });
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
  transport.invalidate.mockReset();
});

afterEach(() => {
  disconnectFromRelay();
  closeAll();
  vi.useRealTimers();
});

describe("account-bound tunnel", () => {
  it("answers JSON while a binary send is outstanding and ends the file when ws calls back", async () => {
    vi.useRealTimers();
    const handle = fileHandles.issue("phone", await recording());
    receive({ type: "file_open", streamId: 5, method: "GET", handle, credit: MAX_CHUNK_BYTES });
    await vi.waitFor(() => expect(transport.binary).toHaveBeenCalledOnce());
    const [chunk, done] = transport.binary.mock.calls[0];
    expect(decodeChunk(chunk)).toMatchObject({
      ok: true,
      streamId: 5,
      payload: new TextEncoder().encode("abc"),
    });
    receive({ type: "ping" });
    expect(
      frames()
        .slice(1)
        .map((frame) => frame.type)
    ).toEqual(["file_head", "pong"]);
    done();
    await vi.waitFor(() =>
      expect(frames().at(-1)).toMatchObject({ type: "file_end", streamId: 5 })
    );
  });

  it("closes an open descriptor when its tunnel closes during a send", async () => {
    vi.useRealTimers();
    const handle = fileHandles.issue("phone", await recording());
    receive({ type: "file_open", streamId: 1, method: "GET", handle, credit: MAX_CHUNK_BYTES });
    await vi.waitFor(() => expect(transport.binary).toHaveBeenCalledOnce());
    const [descriptor] = transport.opened.mock.calls[0];
    expect(descriptor.fd).toBeGreaterThanOrEqual(0);
    tunnel().handlers.get("close")!(1006, "");
    await vi.waitFor(() => expect(descriptor.fd).toBe(-1));
    transport.binary.mock.calls[0][1]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frames().some((f) => f.type === "file_end")).toBe(false);
  });

  it("retires every device's existing file links when remote access is switched off", async () => {
    const file = await recording();
    const links = ["phone", "tablet"].map((device) => fileHandles.issue(device, file));
    expect(links.every((link) => fileHandles.lookup(link))).toBe(true);
    transport.remoteAccess = false;
    reconcileRelay();
    expect(links.map((link) => fileHandles.lookup(link))).toEqual([undefined, undefined]);
  });

  it("dials with the account's host ticket and registers the name and file route key", () => {
    expect(transport.obtainHostTicket).toHaveBeenCalledWith(
      transport.session,
      "Studio",
      expect.any(AbortSignal)
    );
    expect(tunnel().url).toBe(`wss://relay.deusmachine.ai/api/servers/${MACHINE}/tunnel`);
    expect(tunnel().protocols).toEqual([RELAY_PROTOCOL, "ticket-for-user_a"]);
    expect(frames()).toEqual([
      {
        type: "register",
        serverName: "Studio",
        routeKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
    ]);
    expect(getRelayStatus()).toMatchObject({
      state: "connected",
      serverId: MACHINE,
      accountId: "user_a",
      // What a person pastes into an assistant: this computer in the account's Deus Cloud.
      assistantUrl: `https://cloud.test/mcp/${MACHINE}`,
    });
  });

  it("waits for a signed-in account and closes when it signs out", () => {
    transport.session = null;
    reconcileRelay();
    expect(tunnel().close).toHaveBeenCalled();
    expect(getRelayStatus()).toMatchObject({
      state: "signed_out",
      serverId: null,
      assistantUrl: null,
    });

    transport.sockets.length = 0;
    reconcileRelay();
    expect(transport.sockets).toHaveLength(0);
  });

  it("pushes connecting on close and connected only after the relay confirms registration", async () => {
    const states: string[] = [];
    transport.invalidate.mockImplementation((resources: string[]) => {
      if (resources.includes("relayStatus")) states.push(getRelayStatus().state);
    });
    tunnel().handlers.get("close")!(1006, "");
    expect(states.at(-1)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.sockets).toHaveLength(2);
    tunnel().handlers.get("open")!();
    expect(states).not.toContain("connected");
    receive({ type: "registered" });
    expect(states.at(-1)).toBe("connected");
  });

  it("replaces the tunnel when the desktop switches accounts; the old socket's events are ignored", async () => {
    const first = tunnel();
    const link = fileHandles.issue("phone", await recording());
    expect(fileHandles.lookup(link)).toBeDefined();
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
    expect(fileHandles.lookup(link)).toBeUndefined();
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    const second = tunnel();
    expect(second.protocols).toEqual([RELAY_PROTOCOL, "ticket-for-user_b"]);
    expect(getRelayStatus()).toMatchObject({ accountId: "user_b", clients: 0 });

    // Neither a late close nor a late registration belongs to the replacement.
    first.handlers.get("close")!(1000, "");
    second.handlers.get("open")!();
    receive({ type: "registered" }, first);
    expect(getRelayStatus()).toMatchObject({ state: "connecting", connected: false });
    receive({ type: "registered" }, second);
    expect(getRelayStatus()).toMatchObject({ state: "connected", connected: true });
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
  it("redials a tunnel that opens but never confirms registration", async () => {
    tunnel().handlers.get("close")!(1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    tunnel().handlers.get("open")!();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tunnel().terminate).toHaveBeenCalledOnce();
    expect(getRelayStatus().error).toMatch(/did not confirm registration/);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.sockets).toHaveLength(3);
  });

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

  it("admits an escaped text envelope at the byte limit and refuses one more byte", () => {
    const clientId = "phone";
    receive({ type: "client_connected", clientId, deviceToken: "t", accountId: "user_a" });
    const { ws } = connectionOf(clientId)!;

    const limit = 32 * 1024 * 1024 - 4096;
    const envelopeBytes = (payload: string) =>
      Buffer.byteLength(JSON.stringify({ type: "data", clientId, payload }));
    const escaped = '"\\雪'.repeat(1024 * 1024);
    const atLimit = escaped + "a".repeat(limit - envelopeBytes(escaped));
    expect(ws.send(atLimit)).toBeUndefined();
    const accepted = frames().at(-1);
    expect(accepted?.type).toBe("data");
    expect(accepted?.type === "data" && accepted.payload === atLimit).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => ws.send(atLimit + "a")).toThrow(`Frame is too large (${limit + 1} bytes)`);
      expect(warn).toHaveBeenCalledExactlyOnceWith(`[Relay] Dropped data (${limit + 1} bytes)`);
    } finally {
      warn.mockRestore();
    }
    expect(frames().at(-1) === accepted).toBe(true);
    expect(tunnel().close).not.toHaveBeenCalled();
  });

  it("keeps both viewers connected when a workspace title exceeds the tunnel limit", () => {
    for (const clientId of ["phone", "tablet"]) {
      receive({ type: "client_connected", clientId, deviceToken: "t", accountId: "user_a" });
    }
    const phone = connectionOf("phone")!;
    const tablet = connectionOf("tablet")!;
    const title = "x".repeat(33 * 1024 * 1024);
    const result = sendFrame(phone.id, { type: "q:response", id: "workspace", data: { title } });
    expect(tunnel().close).not.toHaveBeenCalled();
    expect(result).toBe("too-large");
    const reply = { type: "q:response", id: "repos", data: [] } as const;
    expect(sendFrame(tablet.id, reply)).toBe("sent");
    expect(frames().at(-1)).toEqual({
      type: "data",
      clientId: "tablet",
      payload: JSON.stringify(reply),
    });
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
    // A device was added: the clients showing the list are sent it again.
    expect(transport.invalidate.mock.calls).toEqual([[["pairedDevices"]]]);
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
    // No device was added, so no list is read again.
    expect(transport.invalidate).not.toHaveBeenCalled();
  });
});

describe("assistants through the relay", () => {
  const JWT = "header.payload.signature";
  const connect = (clientId = "a1", accountId = "user_a") =>
    receive({ type: "client_connected", clientId, deviceToken: JWT, accountId });

  it("verifies the token for this computer and account, then admits an assistant, not a device", async () => {
    transport.admitAssistant.mockResolvedValue({
      assistant: { clientId: "claude", access: "read" },
      signInEndsAt: Date.now() + 600_000,
    });
    connect();
    await vi.waitFor(() =>
      expect(frames().at(-1)).toEqual({ type: "auth_response", clientId: "a1", allowed: true })
    );
    expect(transport.admitAssistant).toHaveBeenCalledWith(JWT, {
      accountId: "user_a",
      machineId: MACHINE,
      cloudUrl: "https://cloud.test",
    });
    const connection = connectionOf("a1");
    expect(connection).toMatchObject({
      deviceId: null,
      isVirtual: true,
      assistant: { clientId: "claude", access: "read" },
    });
    // Not a paired device: it keeps no Mac awake and is not in the device list.
    expect(connectedDeviceIds().size).toBe(0);
    // A device grant never reaches the assistants service.
    expect(transport.run).not.toHaveBeenCalled();
  });

  it("closes the assistant's relay client when its sign-in ends", async () => {
    transport.admitAssistant.mockResolvedValue({
      assistant: { clientId: "claude", access: "operate" },
      signInEndsAt: Date.now() + 50,
    });
    connect();
    await vi.waitFor(() =>
      expect(frames().at(-1)).toEqual({
        type: "auth_response",
        clientId: "a1",
        allowed: false,
        reason: "Assistant sign-in expired",
      })
    );
    expect(frames().at(-2)).toEqual({ type: "auth_response", clientId: "a1", allowed: true });
  });

  it("refuses with the reason the check gave", async () => {
    transport.admitAssistant.mockRejectedValue(
      new AssistantRefusedError("The assistant's sign-in has expired.")
    );
    connect();
    await vi.waitFor(() =>
      expect(frames().at(-1)).toEqual({
        type: "auth_response",
        clientId: "a1",
        allowed: false,
        reason: "The assistant's sign-in has expired.",
      })
    );
  });

  it("refuses an assistant the relay names under another account without checking its token", () => {
    connect("a1", "user_b");
    expect(frames().at(-1)).toMatchObject({ type: "auth_response", allowed: false });
    expect(transport.admitAssistant).not.toHaveBeenCalled();
  });

  it("admits nothing for a client that left while its sign-in was checked", async () => {
    let finish!: (value: unknown) => void;
    transport.admitAssistant.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    connect();
    receive({ type: "client_disconnected", clientId: "a1" });
    finish({
      assistant: { clientId: "claude", access: "operate" },
      signInEndsAt: Date.now() + 600_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(frames().some((f) => f.type === "auth_response")).toBe(false);
  });

  it("keeps admitting device grants exactly as before", () => {
    receive({ type: "client_connected", clientId: "c1", deviceToken: "t", accountId: "user_a" });
    expect(frames().at(-1)).toEqual({ type: "auth_response", clientId: "c1", allowed: true });
    expect(connectionOf("c1")).toMatchObject({ deviceId: "phone", assistant: null });
    expect(transport.admitAssistant).not.toHaveBeenCalled();
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
    expect(transport.invalidate).not.toHaveBeenCalled();

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
    // Only the pairing that succeeded changed the device list.
    expect(transport.invalidate.mock.calls).toEqual([[["pairedDevices"]]]);
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
    expect(transport.invalidate.mock.calls).toEqual([[["relayStatus"]]]);
    transport.invalidate.mockClear();

    expect(revokeDevice("phone")).toBe(true);
    expect(transport.invalidate.mock.calls).toEqual([[["relayStatus"]], [["pairedDevices"]]]);
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
    const frame = { type: "q:mutate", id: "m1", action: "sendMessage", params: {} };
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
  it("publishes the client count when a silent viewer is forgotten", () => {
    receive({ type: "client_connected", clientId: "phone", deviceToken: "t", accountId: "user_a" });
    expect(getRelayStatus().clients).toBe(1);
    transport.invalidate.mockClear();
    vi.advanceTimersByTime(90_000);
    expect(transport.invalidate).toHaveBeenCalledExactlyOnceWith(["relayStatus"]);
    expect(getRelayStatus().clients).toBe(0);
  });

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
