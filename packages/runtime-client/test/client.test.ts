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

  it("sends a request made while connecting once the connection is up, not into a retry", async () => {
    const f = fixture();
    const ready = f.client.connect();
    const read = f.client.sendRequest("settings");
    await Promise.resolve();
    expect(f.socket.frames("q:request")).toEqual([]);
    f.socket.open();
    f.socket.message({ type: "connected" });
    await ready;
    await Promise.resolve();
    const [frame] = f.socket.frames("q:request");
    expect(frame).toMatchObject({ resource: "settings" });
    f.socket.message({ type: "q:response", id: frame.id, data: { theme: "dark" } });
    expect(await read).toEqual({ theme: "dark" });
  });

  it("fails a request whose connection does not come up, and sends nothing", async () => {
    const f = fixture();
    const ready = f.client.connect();
    const read = f.client.sendRequest("settings");
    await Promise.resolve();
    f.socket.close(1006);
    await expect(ready).rejects.toMatchObject({ kind: "unavailable" });
    await expect(read).rejects.toMatchObject({ kind: "unavailable" });
    expect(f.socket.frames("q:request")).toEqual([]);
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

  it("does not replay a headless write after its reply is lost", async () => {
    const f = fixture();
    await online(f);
    const result = expect(f.client.sendMutate("start-job", { id: "job" })).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
    f.socket.close();
    await result;
    await online(f);
    expect(f.sockets.flatMap((socket) => socket.frames("q:mutate"))).toHaveLength(1);
    expect(f.client.diagnostics().pending).toBe(0);
  });

  it("reports a lost reply to a write as an unknown outcome, unlike a read", async () => {
    const f = fixture();
    await online(f);
    const read = expect(f.client.sendRequest("inventory")).rejects.toMatchObject({
      kind: "unavailable",
    });
    const act = expect(f.client.sendMutate("press-button", { id: "go" })).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
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
    await expect(a.client.sendMutate("start-job", {})).rejects.toMatchObject({ kind: "disposed" });
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

describe("streams", () => {
  it("delivers only the events of a subscription the caller made, by its id", async () => {
    const f = fixture();
    const chat = vi.fn(),
      terminal = vi.fn(),
      ambient = vi.fn();
    f.client.onEvent(ambient);
    f.client.listen("sessionEvents", { sessionId: "a" }, chat);
    f.client.listen("terminalOutput", { id: "t1" }, terminal);
    await online(f);
    const [chatSub, terminalSub] = f.socket.frames("q:subscribe");
    expect(chatSub).toMatchObject({ resource: "sessionEvents", params: { sessionId: "a" } });
    expect(chatSub).not.toHaveProperty("after");

    f.socket.message({
      type: "q:event",
      id: chatSub.id,
      event: "sessionEvents",
      data: "hi",
      seq: 4,
    });
    f.socket.message({ type: "q:event", id: terminalSub.id, event: "terminalOutput", data: "$ " });
    f.socket.message({ type: "q:event", id: "evt_unknown", event: "sessionEvents", data: "stray" });

    expect(chat).toHaveBeenCalledExactlyOnceWith("hi", 4);
    expect(terminal).toHaveBeenCalledExactlyOnceWith("$ ", undefined);
    // An event for a subscription nobody holds is not an ambient event.
    expect(ambient).not.toHaveBeenCalled();
  });

  it("resumes after the last event seen on every reconnect, and reports a reset", async () => {
    const f = fixture();
    let last = 0;
    const reset = vi.fn();
    f.client.listen(
      "sessionEvents",
      { sessionId: "a" },
      (_data, seq) => {
        last = seq ?? last;
      },
      { after: () => last, onReset: reset }
    );
    await online(f);
    const first = f.socket.frames("q:subscribe")[0];
    expect(first.after).toBe(0);
    f.socket.message({ type: "q:event", id: first.id, event: "sessionEvents", data: 1, seq: 7 });

    f.socket.close(1006);
    await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
    f.socket.open();
    f.socket.message({ type: "connected" });
    const again = f.socket.frames("q:subscribe")[0];
    expect(again).toMatchObject({ id: first.id, resource: "sessionEvents", after: 7 });

    f.socket.message({ type: "q:reset", id: again.id, seq: 40 });
    expect(reset).toHaveBeenCalledExactlyOnceWith(40);
  });

  it("stops listening when asked, and drops a subscription the host refuses", async () => {
    const f = fixture();
    const events = vi.fn(),
      refused = vi.fn();
    const stop = f.client.listen("sessionEvents", { sessionId: "a" }, events);
    f.client.listen("secrets", undefined, events, { onRefused: refused });
    await online(f);
    const [kept, denied] = f.socket.frames("q:subscribe");

    f.socket.message({ type: "q:error", id: denied.id, code: "SUBSCRIBE_ERROR", message: "no" });
    expect(refused).toHaveBeenCalledOnce();
    expect(refused.mock.calls[0][0]).toMatchObject({ kind: "rejected", message: "no" });

    stop();
    expect(f.socket.frames("q:unsubscribe")).toEqual([{ type: "q:unsubscribe", id: kept.id }]);
    f.socket.message({ type: "q:event", id: kept.id, event: "sessionEvents", data: "late" });
    expect(events).not.toHaveBeenCalled();

    // Neither comes back after a reconnect.
    f.socket.close(1006);
    await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
    f.socket.open();
    f.socket.message({ type: "connected" });
    expect(f.socket.frames("q:subscribe")).toEqual([]);
  });
});
