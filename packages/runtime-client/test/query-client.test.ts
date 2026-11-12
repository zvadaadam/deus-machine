import { QueryClient } from "@tanstack/query-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryRuntimeClient as RuntimeClient,
  type QueryRuntimePorts as RuntimePorts,
} from "../src/query";
import { Socket } from "./socket";

const clients: RuntimeClient[] = [];
function setup(host = "A", overrides: Partial<RuntimePorts> = {}) {
  const sockets: Socket[] = [];
  const client = new RuntimeClient(
    { host, account: "account", grant: `device-${host}` },
    {
      open: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      queryClient: new QueryClient({
        defaultOptions: {
          queries: { gcTime: Infinity, retry: false },
          mutations: { retry: false },
        },
      }),
      retryMs: 100,
      random: () => 0.5,
      ...overrides,
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
async function online(fixture: ReturnType<typeof setup>) {
  const promise = fixture.client.connect();
  await Promise.resolve();
  fixture.socket.open();
  fixture.socket.message({ type: "connected", connectionId: "same-connection-id" });
  await promise;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime-owned q: client", () => {
  it("hydrates a late distinct cache projection after intervening deltas", async () => {
    const f = setup();
    f.client.retainQuery("workspaces", undefined, ["first"]);
    await online(f);
    const { id } = f.socket.frames("q:subscribe")[0];
    f.socket.message({ type: "q:snapshot", id, data: [{ id: "row", title: "before" }] });
    f.socket.message({ type: "q:delta", id, upserted: [{ id: "row", title: "after" }] });
    f.client.retainQuery("workspaces", undefined, ["second"]);
    expect(f.socket.frames("q:subscribe").at(-1)?.id).toBe(id);
    expect(f.client.diagnostics().subscriptions).toBe(1);
    f.socket.message({ type: "q:snapshot", id, data: [{ id: "row", title: "after" }] });
    expect(f.client.queryClient.getQueryData(["second"])).toEqual([{ id: "row", title: "after" }]);
  });

  it("shares a subscription AND its cache projection across 20 observers", async () => {
    const f = setup();
    const merge = vi.fn((old: unknown[], upserted?: unknown[]) => [...old, ...(upserted ?? [])]);
    const stops = Array.from({ length: 20 }, (_, i) =>
      f.client.retainQuery(
        "workspaces",
        i % 2
          ? { state: "ready", nested: { a: 1, b: 2 } }
          : { nested: { b: 2, a: 1 }, state: "ready" },
        ["workspaces"],
        merge
      )
    );
    await online(f);
    expect(f.socket.frames("q:subscribe")).toHaveLength(1);
    const { id } = f.socket.frames("q:subscribe")[0];
    f.socket.message({ type: "q:snapshot", id, data: ["initial"] });
    f.socket.message({ type: "q:delta", id, upserted: ["next"] });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(f.client.queryClient.getQueryData(["workspaces"])).toEqual(["initial", "next"]);
    stops.slice(0, 19).forEach((stop) => stop());
    expect(f.socket.frames("q:unsubscribe")).toHaveLength(0);
    stops[19]();
    stops[19]();
    expect(f.socket.frames("q:unsubscribe")).toHaveLength(1);
    expect(f.client.diagnostics().subscriptions).toBe(0);
  });

  it("keeps hosts, colliding IDs and pending responses separate", async () => {
    const a = setup("A"),
      b = setup("B");
    a.client.retainQuery("workspaces", undefined, ["workspaces"]);
    b.client.retainQuery("workspaces", undefined, ["workspaces"]);
    await online(a);
    await online(b);
    const aid = a.socket.frames("q:subscribe")[0].id,
      bid = b.socket.frames("q:subscribe")[0].id;
    expect(aid).toBe(bid);
    a.socket.message({ type: "q:snapshot", id: aid, data: ["A"] });
    b.socket.message({ type: "q:snapshot", id: bid, data: ["B"] });
    const readA = a.client.sendRequest("session", { sessionId: "same" });
    const readB = b.client.sendRequest("session", { sessionId: "same" });
    const req = a.socket.frames("q:request")[0].id;
    expect(req).toBe(b.socket.frames("q:request")[0].id);
    b.socket.message({ type: "q:response", id: req, data: "reply B" });
    a.socket.message({ type: "q:response", id: req, data: "reply A" });
    expect(await readA).toBe("reply A");
    expect(await readB).toBe("reply B");
    expect(a.client.queryClient.getQueryData(["workspaces"])).toEqual(["A"]);
    expect(b.client.queryClient.getQueryData(["workspaces"])).toEqual(["B"]);
  });

  it("retains stale data through an outage, then sends one subscription on reconnect", async () => {
    const f = setup();
    const params = { sessionId: "original" };
    f.client.retainQuery("session", params, ["session", "original"]);
    await online(f);
    f.socket.message({
      type: "q:snapshot",
      id: f.socket.frames("q:subscribe")[0].id,
      data: { title: "cached" },
    });
    params.sessionId = "changed by caller";
    f.socket.close();
    expect(f.client.queryClient.getQueryData(["session", "original"])).toEqual({ title: "cached" });
    expect(f.client.queryClient.getQueryState(["session", "original"])?.isInvalidated).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    f.socket.open();
    f.socket.message({ type: "connected" });
    const subs = f.socket.frames("q:subscribe");
    expect(subs).toHaveLength(1);
    expect(subs[0].params).toEqual({ sessionId: "original" });
    f.socket.message({ type: "q:snapshot", id: subs[0].id, data: { title: "fresh" } });
    expect(f.client.queryClient.getQueryData(["session", "original"])).toEqual({ title: "fresh" });
    expect(f.client.queryClient.getQueryState(["session", "original"])?.isInvalidated).toBe(false);
  });

  it("does not treat a null messages acknowledgement as an empty transcript", async () => {
    const f = setup("A", {
      acceptSnapshot: (resource, data) => resource !== "messages" || data !== null,
    });
    f.client.queryClient.setQueryData(["messages"], { messages: ["history"] });
    f.client.retainQuery("messages", { sessionId: "session" }, ["messages"]);
    await online(f);
    f.socket.message({ type: "q:snapshot", id: f.socket.frames("q:subscribe")[0].id, data: null });
    expect(f.client.queryClient.getQueryData(["messages"])).toEqual({ messages: ["history"] });
  });

  it("blocks all writes while the relay socket is open but the host is unavailable", async () => {
    const f = setup();
    await online(f);
    const pending = f.client.sendMutate("stopSession", { sessionId: "s" });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unknown-outcome" });
    f.socket.message({ type: "server_reconnecting" });
    await rejected;
    const count = f.socket.sent.length;
    await expect(f.client.sendMutate("createSession", {})).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(f.client.connect()).rejects.toMatchObject({ kind: "unavailable" });
    expect(f.client.sendToolResponse("tool", "answer")).toBe(false);
    expect(f.socket.sent).toHaveLength(count);
    f.socket.message({ type: "ping" });
    expect(f.socket.sent.at(-1)?.type).toBe("pong");
    // Only a fresh, authenticated socket makes the host writable again.
    f.socket.close(1012);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.sockets).toHaveLength(2);
    f.socket.open();
    f.socket.message({ type: "authenticated" });
    expect(f.client.isConnected()).toBe(true);
  });

  it("reports an uncertain write outcome and never resends it", async () => {
    const f = setup();
    await online(f);
    const rejected = expect(f.client.sendMutate("sendMessage", {})).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
    f.socket.close();
    await rejected;
    await vi.advanceTimersByTimeAsync(100);
    f.socket.open();
    f.socket.message({ type: "connected" });
    expect(f.socket.frames("q:mutate")).toHaveLength(0);
    expect(f.client.diagnostics().pending).toBe(0);
  });

  it("clears completed write timers and handles q:error for writes", async () => {
    const f = setup();
    await online(f);
    const write = f.client.sendMutate("stopSession", {});
    f.socket.message({
      type: "q:mutate_result",
      id: f.socket.frames("q:mutate")[0].id,
      success: true,
      data: { unconfirmed: false },
    });
    expect(await write).toEqual({ success: true, data: { unconfirmed: false } });
    expect(vi.getTimerCount()).toBe(1);
    const rejected = f.client.sendMutate("stopSession", {});
    const check = expect(rejected).rejects.toMatchObject({
      kind: "rejected",
      message: "not permitted",
    });
    f.socket.message({
      type: "q:error",
      id: f.socket.frames("q:mutate")[1].id,
      message: "not permitted",
    });
    await check;
    expect(vi.getTimerCount()).toBe(1);
    expect(f.client.isConnected()).toBe(true);
  });

  it("distinguishes a read timeout from a sent write timeout", async () => {
    const f = setup();
    await online(f);
    const read = expect(
      f.client.sendRequest("workspaces", undefined, { timeoutMs: 20 })
    ).rejects.toMatchObject({ kind: "unavailable" });
    const write = expect(f.client.sendMutate("sendMessage", {}, 20)).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
    await vi.advanceTimersByTimeAsync(20);
    await read;
    await write;
    expect(f.client.diagnostics().pending).toBe(0);
  });

  it("revokes one client, clears its cache, rejects pending work, and never reconnects", async () => {
    const onAuthFailure = vi.fn();
    const a = setup("A", { onAuthFailure }),
      b = setup("B");
    await online(a);
    await online(b);
    a.client.queryClient.setQueryData(["secret"], "A");
    b.client.queryClient.setQueryData(["secret"], "B");
    const events = vi.fn();
    a.client.listen("sessionEvents", { sessionId: "s" }, events);
    const listening = a.socket.frames("q:subscribe")[0].id;
    const rejected = expect(a.client.sendRequest("settings")).rejects.toMatchObject({
      kind: "unavailable",
    });
    const stale = a.socket;
    a.socket.close(4001);
    await rejected;
    stale.message({ type: "connected" });
    stale.message({ type: "q:event", id: listening, event: "sessionEvents", data: "A" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).not.toHaveBeenCalled();
    expect(a.client.getState()).toBe("revoked");
    expect(a.client.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(a.sockets).toHaveLength(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(b.client.queryClient.getQueryData(["secret"])).toBe("B");
    expect(b.client.isConnected()).toBe(true);
  });

  it("ignores old socket callbacks after forced reconnect", async () => {
    const f = setup();
    await online(f);
    const events = vi.fn();
    f.client.listen("sessionEvents", { sessionId: "s" }, events);
    const old = f.socket;
    const { id } = old.frames("q:subscribe")[0];
    f.client.forceReconnect();
    await Promise.resolve();
    f.socket.open();
    f.socket.message({ type: "connected" });
    // The listener returns on the new socket under the same id: only the socket tells them apart.
    expect(f.socket.frames("q:subscribe")).toMatchObject([{ id, resource: "sessionEvents" }]);
    old.close();
    old.message({ type: "q:event", id, event: "sessionEvents", data: "wrong-host" });
    expect(events).not.toHaveBeenCalled();
    f.socket.message({ type: "q:event", id, event: "sessionEvents", data: "current" });
    expect(events).toHaveBeenCalledExactlyOnceWith("current");
    expect(f.client.isConnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retries endpoint resolution failures under the same connection owner", async () => {
    const socket = new Socket();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("port unavailable"))
      .mockResolvedValue(socket);
    const f = setup("A", { open });
    await expect(f.client.connect()).rejects.toMatchObject({ kind: "unavailable" });
    await vi.advanceTimersByTimeAsync(100);
    socket.open();
    socket.message({ type: "connected" });
    expect(f.client.isConnected()).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("closes a late-resolving socket after disposal", async () => {
    let resolve!: (socket: Socket) => void;
    const f = setup("A", {
      open: () =>
        new Promise<Socket>((yes) => {
          resolve = yes;
        }),
    });
    const connecting = expect(f.client.connect()).rejects.toMatchObject({ kind: "disposed" });
    f.client.dispose();
    await connecting;
    const socket = new Socket();
    resolve(socket);
    await Promise.resolve();
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins an automatic in-flight reconnect without opening another socket", async () => {
    const f = setup();
    await online(f);
    f.socket.close();
    await vi.advanceTimersByTimeAsync(100);
    const connected = f.client.connect();
    expect(f.sockets).toHaveLength(2);
    f.socket.open();
    f.socket.message({ type: "connected" });
    await connected;
    expect(f.sockets).toHaveLength(2);
  });

  it("bounds a handshake that never authenticates", async () => {
    const f = setup("A", { timeoutMs: 50 });
    const promise = expect(f.client.connect()).rejects.toMatchObject({ kind: "unavailable" });
    await Promise.resolve();
    f.socket.open();
    await vi.advanceTimersByTimeAsync(50);
    await promise;
    expect(f.socket.readyState).toBe(3);
    expect(f.client.getState()).toBe("offline");
  });

  it("disposes intercepted cloud reads before a late response can reach a cache writer", async () => {
    let resolve!: (value: unknown) => void;
    const f = setup("cloud", {
      request: () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    });
    await f.client.connect();
    const write = vi.fn();
    const promise = f.client.sendRequest("workspaces").then(write);
    const rejected = expect(promise).rejects.toMatchObject({ kind: "unavailable" });
    f.client.dispose();
    resolve(["old account"]);
    await rejected;
    expect(write).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
  });
});
