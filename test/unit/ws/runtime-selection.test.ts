import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ mode: "web-production", host: "A" }));
vi.mock("@/shared/config/backend.config", () => ({
  getDeploymentMode: () => config.mode,
  getServerIdFromUrl: () => config.host,
  resolveBackendEndpoints: async (host: string, mode: string) => ({
    wsUrl: `wss://${host ?? mode}/ws`,
  }),
}));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    super();
    Socket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "test" }));
  }
}
/** A Deus account session as the browser stores it; only its claims are read here. */
const session = (sub: string) =>
  `e30.${btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
const cloud = vi.hoisted(() => ({
  answer: (_url: string): Response | Promise<Response> =>
    Response.json({ ticket: `ticket-${Math.random()}` }),
  calls: [] as string[],
}));

let api: typeof import("@/platform/ws/query-protocol-client");
let auth: typeof import("@/platform/ws/device-auth");
let access: typeof import("@/platform/ws/relay-access");
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  config.mode = "web-production";
  config.host = "A";
  Socket.all = [];
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { hostname: "localhost" } })
  );
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("WebSocket", Socket);
  cloud.calls = [];
  cloud.answer = () => Response.json({ ticket: `ticket-${cloud.calls.length}` });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      cloud.calls.push(url);
      return cloud.answer(url);
    })
  );
  sessionStorage.setItem("deus_cloud_session", session("user_a"));
  api = await import("@/platform/ws/query-protocol-client");
  auth = await import("@/platform/ws/device-auth");
  access = await import("@/platform/ws/relay-access");
});
afterEach(() => {
  api.getRuntimeClient().dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function online(client = api.getRuntimeClient()) {
  const connected = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.all.at(-1)!;
  socket.open();
  socket.message({ type: "authenticated" });
  await connected;
  return socket;
}

describe("selected runtime and device grants", () => {
  it("scopes relay grants to the account and keeps them through sign-out", () => {
    auth.storeToken("token-A", "Phone", "A");
    auth.storeToken("token-B", "Tablet", "B");
    expect(localStorage.getItem("deus_device_token:user_a:A")).toBe("token-A");

    sessionStorage.setItem("deus_cloud_session", session("user_b"));
    expect(auth.getStoredToken("A")).toBeNull();
    sessionStorage.removeItem("deus_cloud_session");
    expect(auth.getStoredToken("A")).toBeNull();
    expect(() => auth.storeToken("x", "Phone", "A")).toThrow("Sign in");

    sessionStorage.setItem("deus_cloud_session", session("user_a"));
    expect(auth.getStoredToken("A")).toBe("token-A");
    auth.signOut("A");
    expect(auth.getStoredToken("A")).toBeNull();
    expect(auth.getStoredToken("B")).toBe("token-B");
  });

  it("never sends a pre-account relay grant", () => {
    localStorage.setItem("deus_device_token", "legacy");
    localStorage.setItem("deus_device_token:A", "legacy-A");
    expect(auth.getStoredToken("A")).toBeNull();
  });

  it("disposes old operations and cache on a host switch and ignores its late auth failure", async () => {
    auth.storeToken("token-A", "Phone", "A");
    auth.storeToken("token-B", "Tablet", "B");
    const a = api.selectRuntime("A"),
      socketA = await online(a);
    a.queryClient.setQueryData(["session", "same"], "private A");
    const pending = a.sendCommand("stopSession", { sessionId: "same" });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unknown-outcome" });
    const b = api.selectRuntime("B");
    await rejected;
    expect(a.getState()).toBe("disposed");
    expect(a.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(b.queryClient.getQueryData(["session", "same"])).toBeUndefined();
    const socketB = await online(b);
    expect(socketB.url).toBe("wss://B/ws");
    expect(socketB.protocols?.[0]).toBe("deus.relay.v2");
    expect(cloud.calls.at(-1)).toBe("https://cloud.deusmachine.ai/me/machines/B/tickets");
    expect(socketB.sent).toContainEqual({ type: "authenticate", token: "token-B" });
    socketA.message({ type: "auth_failed" });
    expect(api.getRuntimeClient()).toBe(b);
    expect(auth.getStoredToken("B")).toBe("token-B");
    expect(socketB.sent.some((frame) => frame.type === "q:command")).toBe(false);
  });

  it("rotates the cache on same-host re-pairing but not on another host's token change", async () => {
    auth.storeToken("token-A", "Phone", "A");
    const a = api.selectRuntime("A");
    await online(a);
    const changed = vi.fn();
    const stop = api.onRuntimeChange(changed);
    auth.storeToken("token-B", "Tablet", "B");
    expect(api.getRuntimeClient()).toBe(a);
    auth.storeToken("new-A", "Phone", "A");
    const replacement = api.getRuntimeClient();
    expect(replacement).not.toBe(a);
    expect(replacement.identity.grant).not.toBe(a.identity.grant);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await online(replacement)).sent).toContainEqual({
      type: "authenticate",
      token: "new-A",
    });
    stop();
  });

  it("binds forced reconnects to the original host even before the next route commits", async () => {
    auth.storeToken("token-A", undefined, "A");
    const a = api.selectRuntime("A");
    await online(a);
    config.host = "B";
    a.forceReconnect();
    await online(a);
    expect(Socket.all.map((socket) => socket.url)).toEqual(["wss://A/ws", "wss://A/ws"]);
    // A ticket opens one socket: each dial carries a fresh one.
    expect(Socket.all.map((socket) => socket.protocols?.[1])).toEqual(["ticket-1", "ticket-2"]);
  });

  it("replaces the relay runtime when the browser's account changes", async () => {
    auth.storeToken("token-A", "Phone", "A");
    const a = api.selectRuntime("A");
    await online(a);
    expect(a.identity.account).toBe("user_a");
    sessionStorage.setItem("deus_cloud_session", session("user_b"));
    auth.notifyAuthChange();
    const b = api.getRuntimeClient();
    expect(b).not.toBe(a);
    expect(a.getState()).toBe("disposed");
    expect(b.identity.account).toBe("user_b");
  });

  it("stops dialing a computer the account does not have, and retries on request", async () => {
    auth.storeToken("token-A", "Phone", "A");
    cloud.answer = () => Response.json({ error: "NOT_FOUND" }, { status: 404 });
    const a = api.selectRuntime("A");
    await expect(a.connect()).rejects.toMatchObject({ kind: "disposed" });
    expect(a.getState()).toBe("revoked");
    expect(access.isMachineUnavailable("user_a", "A")).toBe(true);
    // The grant stays: the computer, not this device, is what went missing.
    expect(auth.getStoredToken("A")).toBe("token-A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cloud.calls).toHaveLength(1);

    cloud.answer = () => Response.json({ ticket: "ticket-again" });
    access.clearMachineUnavailable("user_a", "A");
    const retried = api.selectRuntime("A");
    expect(retried).not.toBe(a);
    expect((await online(retried)).protocols?.[1]).toBe("ticket-again");
  });

  it("stops dialing when Deus Cloud refuses the request outright", async () => {
    auth.storeToken("token-A", "Phone", "A");
    cloud.answer = () => Response.json({ error: "FORBIDDEN" }, { status: 403 });
    const a = api.selectRuntime("A");
    await expect(a.connect()).rejects.toMatchObject({ kind: "disposed" });
    expect(a.getState()).toBe("revoked");
    expect(access.isMachineUnavailable("user_a", "A")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cloud.calls).toHaveLength(1);
  });

  it("drops a session Deus Cloud refuses, without redialing", async () => {
    auth.storeToken("token-A", "Phone", "A");
    cloud.answer = () => Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const a = api.selectRuntime("A");
    await expect(a.connect()).rejects.toThrow();
    expect(sessionStorage.getItem("deus_cloud_session")).toBeNull();
    expect(api.getRuntimeClient()).not.toBe(a);
    expect(api.getRuntimeClient().identity.account).toBe("signed-out");
    expect(cloud.calls).toHaveLength(1);
  });

  it("keeps redialing while Deus Cloud is unreachable", async () => {
    auth.storeToken("token-A", "Phone", "A");
    cloud.answer = () => Promise.reject(new TypeError("Failed to fetch"));
    const a = api.selectRuntime("A");
    await expect(a.connect()).rejects.toMatchObject({ kind: "unavailable" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cloud.calls.length).toBeGreaterThan(1);
    expect(a.getState()).not.toBe("revoked");
  });

  it("requires a grant even when a relay frontend is served from localhost", () => {
    expect(auth.needsRemoteAuth()).toBe(true);
  });

  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])(
    "keeps direct %s access local",
    (hostname) => {
      config.mode = "web-standalone";
      Object.assign(window.location, { hostname });
      expect(auth.needsRemoteAuth()).toBe(false);
    }
  );

  it("authenticates direct remote browsers and replaces revoked grants without a retry loop", async () => {
    config.mode = "web-standalone";
    Object.assign(window.location, { hostname: "mac.test" });
    expect(auth.needsRemoteAuth()).toBe(true);
    auth.storeToken("direct-grant");
    const a = api.selectRuntime();
    const socket = await online(a);
    expect(socket.sent).toContainEqual({ type: "initialize", token: "direct-grant" });
    socket.message({ type: "auth_failed" });
    expect(auth.getStoredToken()).toBeNull();
    expect(api.getRuntimeClient()).not.toBe(a);
    expect(a.getState()).toBe("revoked");
    auth.storeToken("replacement");
    expect((await online()).sent).toContainEqual({ type: "initialize", token: "replacement" });
  });

  it("does not confuse account login with a remote device grant", () => {
    config.mode = "web-direct";
    Object.assign(window.location, { hostname: "deusmachine.ai" });
    expect(auth.needsRemoteAuth()).toBe(false);
  });

  it("replaces a direct account's cache on bearer change and keeps its adapter out of relay mode", async () => {
    config.mode = "web-direct";
    sessionStorage.setItem("deus_cloud_session", "account-A");
    const adapter = vi.fn(async () => "account data");
    api.setQueryRequestInterceptor(adapter);
    const a = api.getRuntimeClient();
    await a.connect();
    expect(await a.sendRequest("workspaces")).toBe("account data");
    a.queryClient.setQueryData(["workspaces"], "A private data");
    sessionStorage.setItem("deus_cloud_session", "account-B");
    auth.notifyAuthChange();
    const b = api.getRuntimeClient();
    expect(b).not.toBe(a);
    expect(a.getState()).toBe("disposed");
    expect(b.queryClient.getQueryData(["workspaces"])).toBeUndefined();
    expect(await b.sendRequest("workspaces")).toBe("account data");
    config.mode = "web-production";
    sessionStorage.setItem("deus_cloud_session", session("user_a"));
    auth.storeToken("token-A", undefined, "A");
    const relay = api.selectRuntime("A");
    await online(relay);
    const read = relay.sendRequest("workspaces");
    const socket = Socket.all.at(-1)!;
    const request = socket.sent.find((frame) => frame.type === "q:request")!;
    socket.message({ type: "q:response", id: request.id, data: "relay data" });
    expect(await read).toBe("relay data");
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
