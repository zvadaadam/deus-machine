import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/query-core";
import { QueryRuntimeClient, type QueryRuntimePorts } from "../src/query";
import { Socket } from "./socket";

const clients: QueryRuntimeClient[] = [];
function fixture(overrides: Partial<QueryRuntimePorts> = {}) {
  const sockets: Socket[] = [];
  const client = new QueryRuntimeClient(
    { host: "host", account: "account", grant: "grant" },
    {
      open: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      queryClient: new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      }),
      retryMs: 20,
      random: () => 0.5,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
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
async function online(f: ReturnType<typeof fixture>) {
  const ready = f.client.connect();
  await Promise.resolve();
  f.socket.open();
  f.socket.message({ type: "connected" });
  await ready;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("network faults", () => {
  it("detects a silent open socket, retains stale data, restores reads and never replays a write", async () => {
    const f = fixture();
    f.client.retainQuery("rows", {}, ["rows"]);
    await online(f);
    f.socket.message({
      type: "q:snapshot",
      id: f.socket.frames("q:subscribe")[0].id,
      data: ["cached"],
    });
    const read = expect(f.client.sendRequest("rows")).rejects.toMatchObject({
      kind: "unavailable",
    });
    const write = expect(f.client.sendCommand("create", {})).rejects.toMatchObject({
      kind: "unknown-outcome",
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(f.client.getState()).toBe("offline");
    await read;
    await write;
    expect(f.client.queryClient.getQueryData(["rows"])).toEqual(["cached"]);
    expect(f.client.queryClient.getQueryState(["rows"])?.isInvalidated).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    f.socket.open();
    f.socket.message({ type: "connected" });
    const frames = f.socket.frames("q:subscribe");
    expect(frames).toHaveLength(1);
    f.socket.message({ type: "q:snapshot", id: frames[0].id, data: ["recovered"] });
    expect(f.client.queryClient.getQueryData(["rows"])).toEqual(["recovered"]);
    expect(f.sockets.flatMap((socket) => socket.frames("q:command"))).toHaveLength(1);
    expect(f.client.diagnostics().pending).toBe(0);
  });

  it("requires the matching pong even when unrelated inbound traffic still arrives", async () => {
    const f = fixture();
    await online(f);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.socket.frames("ping")).toHaveLength(1);
    f.socket.message({ type: "pong", id: "another-probe" });
    f.socket.message({ type: "q:event", event: "background", data: true });
    f.socket.message({ type: "ping" });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.client.getState()).toBe("offline");
  });

  it("tolerates slow matching heartbeats without accumulating sockets or timers", async () => {
    const f = fixture();
    await online(f);
    for (let cycle = 0; cycle < 20; cycle++) {
      await vi.advanceTimersByTimeAsync(149);
      f.socket.message({ type: "pong", id: f.socket.frames("ping").at(-1)?.id });
      expect(f.client.isConnected()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(f.sockets).toHaveLength(1);
  });

  it("keeps the relay alive while its host is offline without enabling writes", async () => {
    const f = fixture();
    await online(f);
    f.socket.message({ type: "server_reconnecting" });
    for (let cycle = 0; cycle < 5; cycle++) {
      await vi.advanceTimersByTimeAsync(100);
      const probe = f.socket.frames("ping").at(-1);
      expect(probe).toBeDefined();
      f.socket.message({ type: "pong", id: probe?.id });
      expect(f.client.getState()).toBe("offline");
    }
    await expect(f.client.sendMutate("create", {})).rejects.toMatchObject({ kind: "unavailable" });
    // A returning host has the relay close its waiting viewers (1012); each redials
    // and authenticates again before it is online.
    f.socket.close(1012);
    expect(f.client.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.sockets).toHaveLength(2);
    f.socket.open();
    f.socket.message({ type: "authenticated" });
    expect(f.client.isConnected()).toBe(true);
  });

  it("cleans up a pending probe and ignores late frames after disposal", async () => {
    const f = fixture();
    await online(f);
    await vi.advanceTimersByTimeAsync(100);
    const ping = f.socket.frames("ping").at(-1);
    f.client.dispose();
    f.socket.message({ type: "pong", id: ping?.id });
    f.socket.message({ type: "connected" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.client.getState()).toBe("disposed");
    expect(f.sockets).toHaveLength(1);
  });

  it("closes out-of-order endpoint resolutions and lets only the newest generation connect", async () => {
    const resolvers: Array<(socket: Socket) => void> = [];
    const f = fixture({ open: () => new Promise<Socket>((resolve) => resolvers.push(resolve)) });
    const ready = f.client.connect();
    f.client.forceReconnect();
    f.client.forceReconnect();
    const sockets = resolvers.map(() => new Socket());
    resolvers[2](sockets[2]);
    await Promise.resolve();
    sockets[2].open();
    sockets[2].message({ type: "connected" });
    await ready;
    resolvers[1](sockets[1]);
    resolvers[0](sockets[0]);
    await Promise.resolve();
    expect(sockets.map((socket) => socket.readyState)).toEqual([3, 3, 1]);
    expect(f.client.isConnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reauthenticates before restoring subscriptions after a relay service restart", async () => {
    const f = fixture({ authenticate: () => ({ type: "authenticate", token: "bound-token" }) });
    f.client.retainQuery("rows", {}, ["rows"]);
    await online(f);
    f.socket.close(1012);
    await vi.advanceTimersByTimeAsync(20);
    f.socket.open();
    expect(f.socket.sent).toEqual([{ type: "authenticate", token: "bound-token" }]);
    await expect(f.client.sendCommand("create", {})).rejects.toMatchObject({ kind: "unavailable" });
    f.socket.message({ type: "authenticated" });
    expect(f.socket.frames("q:subscribe")).toHaveLength(1);
    expect(f.socket.frames("q:command")).toHaveLength(0);
  });

  it("bounds retries after repeated failed handshakes and cancels them on disposal", async () => {
    const f = fixture({
      open: async () => {
        throw new Error("Network unavailable");
      },
    });
    await expect(f.client.connect()).rejects.toMatchObject({ kind: "unavailable" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.client.diagnostics().generation).toBeLessThan(40);
    expect(vi.getTimerCount()).toBe(1);
    f.client.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates malformed frames and failed observers from healthy consumers", async () => {
    const f = fixture();
    await online(f);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    f.client.onEvent(() => {
      throw new Error("Broken consumer");
    });
    f.client.onEvent(healthy);
    for (const data of ["not-json", "null", "[]", "42", '{"type":"unknown"}'])
      f.socket.emit("message", { data });
    f.socket.message({ type: "q:event", event: "valid", data: 7 });
    expect(healthy).toHaveBeenCalledExactlyOnceWith("valid", 7);
    expect(f.client.isConnected()).toBe(true);
  });

  it("does not leak probe timers with a synchronous logical transport", async () => {
    const f = fixture();
    await online(f);
    const send = f.socket.send.bind(f.socket);
    f.socket.send = (raw) => {
      send(raw);
      const frame = JSON.parse(raw);
      if (frame.type === "ping") f.socket.message({ type: "pong", id: frame.id });
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.socket.frames("ping")).toHaveLength(10);
    expect(f.client.isConnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("ignores a late timed-out reply without resolving a newer request", async () => {
    const f = fixture();
    await online(f);
    const expired = expect(
      f.client.sendRequest("rows", {}, { timeoutMs: 10 })
    ).rejects.toMatchObject({ kind: "unavailable" });
    const first = f.socket.frames("q:request")[0].id;
    await vi.advanceTimersByTimeAsync(10);
    await expired;
    const second = f.client.sendRequest("rows");
    const id = f.socket.frames("q:request")[1].id;
    f.socket.message({ type: "q:response", id: first, data: "old" });
    expect(f.client.diagnostics().pending).toBe(1);
    f.socket.message({ type: "q:response", id, data: "fresh" });
    expect(await second).toBe("fresh");
  });

  it("allows an authoritative null snapshot to clear a deleted resource", async () => {
    const f = fixture();
    f.client.retainQuery("item", {}, ["item"]);
    await online(f);
    const id = f.socket.frames("q:subscribe")[0].id;
    f.socket.message({ type: "q:snapshot", id, data: { id: "deleted-later" } });
    f.socket.message({ type: "q:snapshot", id, data: null });
    expect(f.client.queryClient.getQueryData(["item"])).toBeNull();
    f.client.retainQuery("item", {}, ["late-projection"]);
    expect(f.socket.frames("q:subscribe")).toHaveLength(2);
  });

  it("handles a burst for 200 consumers through one subscription and one projection", async () => {
    const f = fixture();
    const merge = vi.fn((old: Array<{ id: string }>, rows?: unknown[]) => [
      ...old,
      ...(rows ?? []),
    ]);
    const stops = Array.from({ length: 200 }, () =>
      f.client.retainQuery("rows", {}, ["rows"], merge)
    );
    await online(f);
    const id = f.socket.frames("q:subscribe")[0].id;
    f.socket.message({ type: "q:snapshot", id, data: [] });
    for (let index = 0; index < 1000; index++)
      f.socket.message({ type: "q:delta", id, upserted: [{ id: String(index) }] });
    expect(merge).toHaveBeenCalledTimes(1000);
    expect(f.client.queryClient.getQueryData(["rows"])).toHaveLength(1000);
    stops.forEach((stop) => stop());
    expect(f.socket.frames("q:subscribe")).toHaveLength(1);
    expect(f.socket.frames("q:unsubscribe")).toHaveLength(1);
    expect(f.client.diagnostics()).toMatchObject({ pending: 0, subscriptions: 0, observers: 0 });
  });
});
