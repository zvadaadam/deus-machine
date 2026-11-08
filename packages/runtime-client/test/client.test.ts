import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, RuntimeError } from "../src/index";
import { Socket } from "./socket";

// The root entry must work without the optional cache integration being loaded.
vi.mock("@tanstack/query-core", () => {
  throw new Error("Core loaded an optional peer");
});
const clients: RuntimeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
});
function fixture() {
  const sockets: Socket[] = [];
  const client = new RuntimeClient(
    { host: "test-host", account: "test-account", grant: "opaque-grant" },
    {
      open: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    }
  );
  clients.push(client);
  return {
    client,
    sockets,
    get socket() {
      return sockets.at(-1)!;
    },
  };
}
async function online(f: ReturnType<typeof fixture>) {
  const ready = f.client.connect();
  await Promise.resolve();
  f.socket.open();
  f.socket.message({ type: "connected" });
  await ready;
}

describe("headless client", () => {
  it("reads and subscribes to an application's resource without React, a cache or app imports", async () => {
    expect(typeof window).toBe("undefined");
    const f = fixture();
    const snapshot = vi.fn(),
      delta = vi.fn();
    const stop = f.client.subscribe("inventory", { category: "tools" }, snapshot, delta);
    await online(f);
    const id = f.socket.frames("q:subscribe")[0].id;
    f.socket.message({ type: "q:snapshot", id, data: [{ id: "tool", stock: 3 }] });
    f.socket.message({ type: "q:delta", id, upserted: [{ id: "tool", stock: 2 }], cursor: 9 });
    expect(snapshot).toHaveBeenCalledExactlyOnceWith([{ id: "tool", stock: 3 }]);
    expect(delta).toHaveBeenCalledExactlyOnceWith([{ id: "tool", stock: 2 }], undefined, 9);
    const request = f.client.sendRequest("inventory-count");
    f.socket.message({ type: "q:response", id: f.socket.frames("q:request")[0].id, data: 2 });
    expect(await request).toBe(2);
    stop();
    expect(f.client.diagnostics()).toMatchObject({ subscriptions: 0, observers: 0, pending: 0 });
    expect(f.client).not.toHaveProperty("queryClient");
  });

  it("keeps equal request IDs on different connections independent", async () => {
    const a = fixture(),
      b = fixture();
    await online(a);
    await online(b);
    const readA = a.client.sendRequest("inventory"),
      readB = b.client.sendRequest("inventory");
    const id = a.socket.frames("q:request")[0].id;
    expect(b.socket.frames("q:request")[0].id).toBe(id);
    a.socket.message({ type: "q:response", id, data: "A" });
    b.socket.message({ type: "q:response", id, data: "B" });
    expect(await readA).toBe("A");
    expect(await readB).toBe("B");
  });

  it("does not replay a headless command after its acknowledgment is lost", async () => {
    const f = fixture();
    await online(f);
    const result = expect(f.client.sendCommand("start-job", { id: "job" })).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
    f.socket.close();
    await result;
    await online(f);
    expect(f.sockets.flatMap((socket) => socket.frames("q:command"))).toHaveLength(1);
    expect(f.client.diagnostics().pending).toBe(0);
  });

  it("reports a lost reply to an acting request as an unknown outcome, unlike a read", async () => {
    const f = fixture();
    await online(f);
    const read = expect(f.client.sendRequest("inventory")).rejects.toMatchObject({
      kind: "unavailable",
    });
    const act = expect(
      f.client.sendRequest("press-button", { id: "go" }, { effect: true })
    ).rejects.toMatchObject({ kind: "unknown-outcome" });
    f.socket.close();
    await read;
    await act;
  });

  it("revokes only its own connection and rejects further dispatch", async () => {
    const a = fixture(),
      b = fixture();
    await online(a);
    await online(b);
    a.socket.message({ type: "auth_failed" });
    expect(a.client.getState()).toBe("revoked");
    expect(b.client.isConnected()).toBe(true);
    await expect(a.client.sendCommand("start-job", {})).rejects.toMatchObject({ kind: "disposed" });
  });

  it("ends without retrying when the transport factory refuses definitively", async () => {
    vi.useFakeTimers();
    try {
      const opens = vi.fn(async () => {
        throw new RuntimeError("rejected", "This account cannot reach the host");
      });
      const authFailure = vi.fn();
      const client = new RuntimeClient(
        { host: "h", account: "a", grant: "g" },
        { open: opens, onAuthFailure: authFailure }
      );
      clients.push(client);
      await expect(client.connect()).rejects.toMatchObject({ kind: "disposed" });
      expect(client.getState()).toBe("revoked");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(opens).toHaveBeenCalledOnce();
      // Refusing a dial says nothing about the host's grant: that callback is for the host.
      expect(authFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a transport factory's ordinary failure", async () => {
    vi.useFakeTimers();
    try {
      const sockets: Socket[] = [];
      const opens = vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(() => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        });
      const client = new RuntimeClient(
        { host: "h", account: "a", grant: "g" },
        { open: opens, random: () => 0.5 }
      );
      clients.push(client);
      await expect(client.connect()).rejects.toMatchObject({ kind: "unavailable" });
      await vi.advanceTimersByTimeAsync(500);
      expect(opens).toHaveBeenCalledTimes(2);
      expect(client.getState()).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });
});
