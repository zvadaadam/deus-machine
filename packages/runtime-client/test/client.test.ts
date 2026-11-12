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
/** The connection drops and comes back: `f.socket` is the new one. */
async function reconnect(f: ReturnType<typeof fixture>) {
  const before = f.sockets.length;
  f.socket.close(1006);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(before + 1));
  f.socket.open();
  f.socket.message({ type: "connected" });
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

  it("returns to a live read after the last cursor it was answered with", async () => {
    const f = fixture();
    f.client.subscribe("messages", { sessionId: "empty" }, vi.fn(), vi.fn());
    f.client.subscribe("messages", { sessionId: "moved" }, vi.fn(), vi.fn());
    f.client.subscribe("workspaces", undefined, vi.fn(), vi.fn());
    await online(f);
    const [empty, moved, plain] = f.socket.frames("q:subscribe");
    // The first time there is nowhere to resume from.
    for (const frame of [empty, moved, plain]) expect(frame).not.toHaveProperty("after");
    // Where the read stands arrives with its acknowledgment (0 before any row: still a
    // place to return to), and moves with each delta.
    f.socket.message({ type: "q:snapshot", id: empty.id, data: null, cursor: 0 });
    f.socket.message({ type: "q:snapshot", id: moved.id, data: null, cursor: 3 });
    f.socket.message({ type: "q:delta", id: moved.id, upserted: [{ id: "m", seq: 5 }], cursor: 5 });
    // A read that is sent again whole says nothing about where it stands.
    f.socket.message({ type: "q:snapshot", id: plain.id, data: [{ id: "w" }] });
    f.socket.message({ type: "q:delta", id: plain.id, upserted: [{ id: "w", title: "renamed" }] });

    await reconnect(f);
    expect(f.socket.frames("q:subscribe")).toEqual([
      {
        type: "q:subscribe",
        id: empty.id,
        resource: "messages",
        params: { sessionId: "empty" },
        after: 0,
      },
      {
        type: "q:subscribe",
        id: moved.id,
        resource: "messages",
        params: { sessionId: "moved" },
        after: 5,
      },
      { type: "q:subscribe", id: plain.id, resource: "workspaces" },
    ]);
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
      terminal = vi.fn();
    f.client.listen("sessionEvents", { sessionId: "a" }, chat);
    f.client.listen("terminalOutput", { id: "t1" }, terminal);
    await online(f);
    const [chatSub, terminalSub] = f.socket.frames("q:subscribe");
    expect(chatSub).toEqual({
      type: "q:subscribe",
      id: chatSub.id,
      resource: "sessionEvents",
      params: { sessionId: "a" },
    });

    f.socket.message({
      type: "q:event",
      id: chatSub.id,
      event: "sessionEvents",
      data: "hi",
      seq: 4,
    });
    f.socket.message({ type: "q:event", id: terminalSub.id, event: "terminalOutput", data: "$ " });
    // An event for a subscription nobody holds, or for none, goes nowhere.
    f.socket.message({ type: "q:event", id: "evt_unknown", event: "sessionEvents", data: "stray" });
    f.socket.message({ type: "q:event", event: "sessionEvents", data: "stray" });

    expect(chat).toHaveBeenCalledExactlyOnceWith("hi");
    expect(terminal).toHaveBeenCalledExactlyOnceWith("$ ");
  });

  it("returns to a numbered stream after the last event it received", async () => {
    const f = fixture();
    const reset = vi.fn();
    f.client.listen("sessionEvents", { sessionId: "a" }, vi.fn(), { onReset: reset });
    await online(f);
    const first = f.socket.frames("q:subscribe")[0];
    f.socket.message({ type: "q:event", id: first.id, event: "sessionEvents", data: 1, seq: 7 });
    // An event nobody keeps carries the number of the kept one before it.
    f.socket.message({ type: "q:event", id: first.id, event: "sessionEvents", data: 2, seq: 7 });

    await reconnect(f);
    expect(f.socket.frames("q:subscribe")).toEqual([
      {
        type: "q:subscribe",
        id: first.id,
        resource: "sessionEvents",
        params: { sessionId: "a" },
        after: 7,
      },
    ]);
    expect(reset).not.toHaveBeenCalled();

    // The host no longer holds that far back: read again, and continue from where it stands.
    f.socket.message({ type: "q:reset", id: first.id, seq: 40 });
    expect(reset).toHaveBeenCalledOnce();
    await reconnect(f);
    expect(f.socket.frames("q:subscribe")[0].after).toBe(40);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("returns to where the host said a stream stood, though nothing arrived on it", async () => {
    const f = fixture();
    const reset = vi.fn();
    f.client.listen("sessionEvents", { sessionId: "idle" }, vi.fn(), { onReset: reset });
    await online(f);
    const first = f.socket.frames("q:subscribe")[0];
    f.socket.message({ type: "q:subscribed", id: first.id, seq: 41 });

    await reconnect(f);
    expect(f.socket.frames("q:subscribe")[0]).toMatchObject({ id: first.id, after: 41 });
    // It knows where it was: nothing to read again unless the host says so.
    expect(reset).not.toHaveBeenCalled();
  });

  it("reports a reset when it returns with no place to resume from", async () => {
    const f = fixture();
    const numbered = vi.fn(),
      plain = vi.fn();
    f.client.listen("sessionEvents", { sessionId: "idle" }, vi.fn(), { onReset: numbered });
    f.client.listen("fileChanges", { workspacePath: "/w" }, vi.fn(), { onReset: plain });
    await online(f);
    const [, files] = f.socket.frames("q:subscribe");
    // The host acknowledges both; neither acknowledgment names a position.
    for (const frame of f.socket.frames("q:subscribe"))
      f.socket.message({ type: "q:subscribed", id: frame.id });
    f.socket.message({ type: "q:event", id: files.id, event: "fileChanges", data: {} });
    // The first time is not a return.
    expect(numbered).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();

    await reconnect(f);
    expect(f.socket.frames("q:subscribe").map((frame) => frame.after)).toEqual([
      undefined,
      undefined,
    ]);
    // Neither was given a place to return to: either may have missed events.
    expect(numbered).toHaveBeenCalledOnce();
    expect(plain).toHaveBeenCalledOnce();
  });

  it("shares one subscription among listeners of the same stream and filter", async () => {
    const f = fixture();
    const fold = vi.fn(),
      notice = vi.fn(),
      reset = vi.fn();
    const stopFold = f.client.listen("sessionEvents", { sessionId: "a" }, fold, { onReset: reset });
    const stopNotice = f.client.listen("sessionEvents", { sessionId: "a" }, notice);
    f.client.listen("sessionEvents", { sessionId: "b" }, vi.fn());
    await online(f);
    const subscribed = f.socket.frames("q:subscribe");
    expect(subscribed.map((frame) => frame.params)).toEqual([
      { sessionId: "a" },
      { sessionId: "b" },
    ]);

    // The host sends the event once; both receive it.
    f.socket.message({ type: "q:event", id: subscribed[0].id, event: "sessionEvents", data: "hi" });
    expect(fold).toHaveBeenCalledExactlyOnceWith("hi");
    expect(notice).toHaveBeenCalledExactlyOnceWith("hi");
    f.socket.message({ type: "q:reset", id: subscribed[0].id });
    expect(reset).toHaveBeenCalledOnce();

    // It is given up when the last of them stops.
    stopNotice();
    stopNotice();
    expect(f.socket.frames("q:unsubscribe")).toEqual([]);
    stopFold();
    expect(f.socket.frames("q:unsubscribe")).toEqual([
      { type: "q:unsubscribe", id: subscribed[0].id },
    ]);
  });

  it("does not ask again for a stream a reset stopped during the same reconnect", async () => {
    const f = fixture();
    let stopTerminal = () => {};
    f.client.listen("fileChanges", { workspacePath: "/w" }, vi.fn(), {
      onReset: () => stopTerminal(),
    });
    stopTerminal = f.client.listen("terminalOutput", { id: "t1" }, vi.fn());
    await online(f);

    await reconnect(f);
    expect(f.socket.frames("q:subscribe").map((frame) => frame.resource)).toEqual(["fileChanges"]);
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
    await reconnect(f);
    expect(f.socket.frames("q:subscribe")).toEqual([]);
  });

  it("delivers a locally published event to the listeners its scope matches, online or not", () => {
    const f = fixture();
    const chat = vi.fn(),
      everything = vi.fn(),
      other = vi.fn();
    f.client.listen("toolRequests", { sessionId: "a" }, chat);
    f.client.listen("toolRequests", undefined, everything);
    f.client.listen("toolRequests", { sessionId: "b" }, other);
    f.client.listen("terminalOutput", { sessionId: "a" }, other);

    f.client.publishLocal("toolRequests", { sessionId: "a" }, "ask");

    expect(chat).toHaveBeenCalledExactlyOnceWith("ask");
    expect(everything).toHaveBeenCalledExactlyOnceWith("ask");
    expect(other).not.toHaveBeenCalled();
  });

  it("keeps listeners but sends no subscription when the client answers requests itself", async () => {
    const sockets: Socket[] = [];
    const client = new RuntimeClient(
      { host: "browser", account: "a", grant: "g" },
      {
        open: () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        },
        request: () => null,
      }
    );
    clients.push(client);
    const events = vi.fn();
    client.listen("toolRequests", { sessionId: "a" }, events);
    await client.connect();
    expect(sockets).toHaveLength(0);
    client.publishLocal("toolRequests", { sessionId: "a" }, "ask");
    expect(events).toHaveBeenCalledExactlyOnceWith("ask");
  });
});
