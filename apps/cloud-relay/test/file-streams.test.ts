import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WINDOW_BYTES, encodeChunk, MAX_CHUNK_BYTES } from "../../../shared/tunnel";
import type { RelayFrame } from "../../../shared/types/relay";
import {
  connectAndAuthClient,
  createMockWebSocket,
  createTestDO,
  type MockWebSocket,
} from "./mocks";

const key = "K".repeat(22);
const handle = "h".repeat(22);
const url = `https://object.test/files/${key}/${handle}`;
const headers = (length: number) => ({
  "content-type": "image/png",
  "content-length": String(length),
});
type Open = Extract<RelayFrame, { type: "file_open" }>;
type Harness = Awaited<ReturnType<typeof createTestDO>>;
let relay: Harness["relay"];
let state: Harness["state"];
let host: MockWebSocket;
const socket = (ws: MockWebSocket) => ws as unknown as WebSocket;
const frames = () => host._sentMessages as RelayFrame[];
const opens = () => frames().filter((frame): frame is Open => frame.type === "file_open");
const message = (frame: object, from = host) =>
  relay.webSocketMessage(socket(from), JSON.stringify(frame));
const fetchFile = (init?: RequestInit, path = url) => relay.fetch(new Request(path, init));
const start = (init?: RequestInit) => {
  const before = opens().length;
  const result = fetchFile(init);
  expect(opens()).toHaveLength(before + 1);
  return { result, id: opens().at(-1)!.streamId };
};
const head = (id: number, fields = headers(1) as Record<string, string>, status = 200) =>
  message({ type: "file_head", streamId: id, status, headers: fields });
const chunk = (id: number, data: Uint8Array, from = host) =>
  relay.webSocketMessage(socket(from), encodeChunk(id, data).buffer);

async function denied(result: Promise<Response>) {
  const response = await result;
  expect(response.status).toBe(404);
  expect([...response.headers]).toEqual([
    ["cache-control", "private"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
  ]);
  expect(await response.text()).toBe("");
}

beforeEach(async () => {
  ({ relay, state } = await createTestDO());
  host = createMockWebSocket(["tunnel"]);
  state.acceptWebSocket(host, ["tunnel"]);
  // Node provides standard streams. The fixed-length native writer is covered by the workerd proof.
  vi.stubGlobal(
    "FixedLengthStream",
    class extends TransformStream<Uint8Array, Uint8Array> {
      constructor() {
        super();
      }
    }
  );
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
    configurable: true,
  });
  await message({ type: "register", routeKey: key });
});
afterEach(async () => {
  await relay.webSocketError(socket(host), new Error("test host closed"));
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("file reads through the object", () => {
  it.each([
    "/files",
    "/files/",
    `/files/${key}`,
    `/files/${key}/`,
    `/files/x/${handle}`,
    `/files/${key}/x`,
    `/files/${key}/${handle}/extra`,
    `/files/${key}/${handle}/`,
  ])("refuses malformed object path %s before looking up a tunnel", async (path) => {
    const lookup = vi.spyOn(state, "getWebSockets");
    const response = fetchFile({}, new URL(path, url).href);
    expect(lookup).not.toHaveBeenCalled();
    expect(opens()).toHaveLength(0);
    await denied(response);
  });

  it("rejects wrong keys, a keyless host and an absent host without opening a file", async () => {
    for (let i = 0; i < 42; i++) {
      const result = fetchFile({}, url.replace(key, "x".repeat(22)));
      expect(opens()).toEqual([]);
      await denied(result);
    }
    const { RelayDO } = await import("../src/relay-do");
    const woken = new RelayDO(state as unknown as DurableObjectState, {});
    const response = woken.fetch(new Request(url, { method: "HEAD" }));
    expect(opens()).toHaveLength(1);
    await woken.webSocketMessage(
      socket(host),
      JSON.stringify({
        type: "file_head",
        streamId: opens()[0].streamId,
        status: 200,
        headers: headers(5),
      })
    );
    expect((await response).status).toBe(200);
    await message({ type: "register" });
    await denied(fetchFile());
    state._websockets.delete(host);
    await denied(fetchFile());
    expect(opens()).toHaveLength(1);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain(key);
  });

  it("preserves GET range metadata, filters host headers, and serves HEAD without a body", async () => {
    const get = start({ headers: { Range: "bytes=2-4" } });
    expect(opens()[0]).toEqual({
      type: "file_open",
      streamId: get.id,
      handle,
      range: "bytes=2-4",
      method: "GET",
      credit: DEFAULT_WINDOW_BYTES,
    });
    const fields = {
      "Content-Type": "Video/MP4",
      "Content-Length": "3",
      "CONTENT-RANGE": "bytes 2-4/8",
      "Accept-Ranges": "bytes",
      ETag: '"item"',
      "Set-Cookie": "test=1",
      "Cache-Control": "public",
      "Referrer-Policy": "unsafe-url",
      "X-Content-Type-Options": "other",
    };
    await head(get.id, fields, 206);
    const res = await get.result;
    expect(res.status).toBe(206);
    expect(Object.fromEntries(res.headers)).toEqual({
      "accept-ranges": "bytes",
      "cache-control": "private",
      "content-length": "3",
      "content-range": "bytes 2-4/8",
      "content-type": "Video/MP4",
      etag: '"item"',
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    await res.body!.cancel();
    const read = start({ method: "HEAD" });
    expect(opens().at(-1)?.method).toBe("HEAD");
    await head(read.id, headers(18));
    const metadata = await read.result;
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-length")).toBe("18");
    expect(metadata.body).toBeNull();
    await message({ type: "file_end", streamId: read.id });
  });

  it("returns an unsatisfiable range with the current file length and no body", async () => {
    const { id, result } = start({ headers: { Range: "bytes=16-" } });
    await head(
      id,
      { "Content-Range": "bytes */8", "Content-Type": "text/html", "Set-Cookie": "x=1" },
      416
    );
    const response = await result;
    expect(response.status).toBe(416);
    expect(response.body).toBeNull();
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-range": "bytes */8",
      "cache-control": "private",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });

  it.each([403, 404, 500])("maps host refusal %i to the common 404", async (status) => {
    const { id, result } = start();
    await head(id, headers(0), status);
    await denied(result);
  });

  it.each([
    undefined,
    "text/html",
    "image/svg+xml",
    "image/png; charset=utf-8",
    "image/png, text/html",
  ])("refuses an unapproved Content-Type (%s) on the relay origin", async (type) => {
    const { id, result } = start();
    const fields: Record<string, string> = { "content-length": "1" };
    if (type !== undefined) fields["content-type"] = type;
    await head(id, fields);
    await denied(result);
  });

  it.each([
    [200, {}],
    [416, {}],
    [416, { "content-range": "bytes 2-4/6" }],
    [416, { "content-range": "bytes */9007199254740992" }],
    [200, { "content-length": "-1" }],
    [200, { "content-length": "9007199254740992" }],
    [206, headers(2)],
    [206, { ...headers(2), "content-range": "bytes 2-4/6" }],
    [206, { ...headers(2), "content-range": "bytes 2-3/3" }],
    [200, { ...headers(2), etag: "bad\nvalue" }],
  ] as [number, Record<string, string>][])(
    "rejects unusable response metadata (%i, %j)",
    async (status, fields) => {
      const { id, result } = start();
      await head(id, { "content-type": "image/png", ...fields }, status);
      await denied(result);
    }
  );

  it("passes bytes in order and grants each chunk credit only when its own write completes", async () => {
    const { id, result } = start();
    await head(id, headers(MAX_CHUNK_BYTES + 1));
    const reader = (await result).body!.getReader();
    const bytes = [new Uint8Array(MAX_CHUNK_BYTES).fill(255), Uint8Array.of(128)];
    await chunk(id, bytes[0]);
    await chunk(id, bytes[1]);
    const credits = () => frames().filter((f) => f.type === "file_credit");
    expect(credits()).toEqual([]);
    const { clientWs, clientId } = await connectAndAuthClient(relay, state);
    await message({ type: "auth_response", clientId, allowed: true });
    const ping = { type: "ping", id: "still-live" };
    await message(ping, clientWs);
    expect(frames()).toContainEqual({ type: "data", clientId, payload: JSON.stringify(ping) });
    const other = start({ method: "HEAD" });
    await head(other.id, headers(1));
    expect((await other.result).status).toBe(200);
    expect(credits()).toEqual([]);
    for (const [index, part] of bytes.entries()) {
      expect(Buffer.from((await reader.read()).value!).equals(part)).toBe(true);
      await vi.waitFor(() => expect(credits()).toHaveLength(index + 1));
      expect(credits().at(-1)).toEqual({ type: "file_credit", streamId: id, bytes: part.length });
    }
    await message({ type: "file_end", streamId: id });
    expect((await reader.read()).done).toBe(true);
  });

  it("cancels the object's open when the public file request aborts and ignores the late reply", async () => {
    const { default: app } = await import("../src/index");
    const controller = new AbortController();
    const result = Promise.resolve(
      app.request(
        `/api/servers/0123456789abcdef/files/${key}/${handle}`,
        { signal: controller.signal },
        { RELAY: { idFromName: () => "object", get: () => relay } }
      )
    );
    expect(opens()).toHaveLength(1);
    const id = opens()[0].streamId;
    controller.abort();
    expect(frames()).toContainEqual({ type: "file_cancel", streamId: id });
    await denied(result);
    await head(id, headers(1));
    await chunk(id, Uint8Array.of(42));
    expect(frames().filter((f) => f.type === "file_credit")).toHaveLength(0);
  });

  it.each(["idle request abort", "pending write rejection"])(
    "frees the slot on %s",
    async (event) => {
      const controller = new AbortController();
      const first = start({ signal: controller.signal });
      await head(first.id, headers(MAX_CHUNK_BYTES + 1));
      const reader = (await first.result).body!.getReader();
      await chunk(first.id, new Uint8Array(MAX_CHUNK_BYTES));
      await reader.read();
      const credits = () => frames().filter((f) => f.type === "file_credit");
      await vi.waitFor(() => expect(credits()).toHaveLength(1));
      if (event === "pending write rejection") await chunk(first.id, Uint8Array.of(43));
      for (let i = 0; i < 7; i++) start();
      const queued = fetchFile({ method: "HEAD" });
      expect(opens()).toHaveLength(8);
      if (event === "idle request abort") controller.abort();
      else await reader.cancel();
      await vi.waitFor(() => expect(opens()).toHaveLength(9));
      const next = opens().at(-1)!;
      await head(next.streamId, headers(0));
      expect((await queued).status).toBe(200);
      expect(
        frames().filter((f) => f.type === "file_cancel" && f.streamId === first.id)
      ).toHaveLength(1);
      expect(credits()).toEqual([
        { type: "file_credit", streamId: first.id, bytes: MAX_CHUNK_BYTES },
      ]);
    }
  );

  it.each([
    [0, MAX_CHUNK_BYTES],
    [1, 2 * MAX_CHUNK_BYTES + 1],
  ])(
    "ends a stalled stream on an invalid %i-byte chunk for a %i-byte file",
    async (size, length) => {
      const { id, result } = start();
      await head(id, headers(length));
      const body = (await result).body!;
      await chunk(id, new Uint8Array(MAX_CHUNK_BYTES));
      await chunk(id, new Uint8Array(size));
      expect(frames()).toContainEqual({ type: "file_cancel", streamId: id });
      await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
      expect(frames().some((frame) => frame.type === "file_credit")).toBe(false);
    }
  );

  it("aborts just the over-credit stream and ignores unknown, malformed and non-host chunks", async () => {
    const bad = start(),
      good = start();
    await head(bad.id, headers(DEFAULT_WINDOW_BYTES + 1));
    await head(good.id, headers(1));
    const body = (await bad.result).body!;
    await chunk(good.id, Uint8Array.of(9), createMockWebSocket(["client", "viewer"]));
    await chunk((good.id + 1) >>> 0, Uint8Array.of(1));
    await relay.webSocketMessage(socket(host), new Uint8Array([1]).buffer);
    for (let n = 0; n < DEFAULT_WINDOW_BYTES; n += MAX_CHUNK_BYTES)
      await chunk(bad.id, new Uint8Array(MAX_CHUNK_BYTES));
    await chunk(bad.id, Uint8Array.of(1));
    expect(frames().filter((f) => f.type === "file_cancel")).toEqual([
      { type: "file_cancel", streamId: bad.id },
    ]);
    await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
    await chunk(good.id, Uint8Array.of(255));
    await message({ type: "file_end", streamId: good.id });
    expect(new Uint8Array(await (await good.result).arrayBuffer())).toEqual(Uint8Array.of(255));
  });

  it("aborts a truncated file and a host error after headers", async () => {
    for (const error of [undefined, "host read failed"]) {
      const { id, result } = start();
      await head(id, headers(error ? 0 : 2));
      await message({ type: "file_end", streamId: id, error });
      await expect((await result).arrayBuffer()).rejects.toBeDefined();
    }
  });

  it("cancels bytes before the head and refuses the request", async () => {
    const { id, result } = start();
    await chunk(id, Uint8Array.of(1));
    expect(frames()).toContainEqual({ type: "file_cancel", streamId: id });
    await denied(result);
  });

  it.each(["duplicate head", "bytes beyond Content-Length"])(
    "breaks the active body on %s",
    async (fault) => {
      const { id, result } = start();
      await head(id, headers(1));
      const body = (await result).body!;
      if (fault === "duplicate head") await head(id, headers(1));
      else await chunk(id, Uint8Array.of(1, 2));
      expect(frames()).toContainEqual({ type: "file_cancel", streamId: id });
      await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
    }
  );

  it.each(["changed", "dropped"])(
    "cancels an active file when the open tunnel's key is %s",
    async (change) => {
      const { id, result } = start();
      await head(id, headers(8));
      const body = (await result).body!;
      await message({
        type: "register",
        routeKey: change === "changed" ? "n".repeat(22) : undefined,
      });
      expect(frames().filter((f) => f.type === "file_cancel")).toEqual([
        { type: "file_cancel", streamId: id },
      ]);
      await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
      await denied(fetchFile());
    }
  );

  it("drops old waiters before releasing active reads and ignores late heads, bytes and close from the replaced tunnel", async () => {
    const active = start(),
      pending = start();
    await head(active.id, headers(4));
    const body = (await active.result).body!;
    for (let i = 0; i < 6; i++) start();
    const waiting = fetchFile();
    expect(opens()).toHaveLength(8);
    const old = host;
    old.close.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    const replacement = createMockWebSocket([], null);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = createMockWebSocket([], null);
        1 = replacement;
      }
    );
    Object.assign(relay, { upgraded: () => new Response(null) });
    const upgraded = await relay.fetch(
      new Request("https://object.test/tunnel", {
        headers: {
          "x-deus-relay-admission": JSON.stringify({
            accountId: "user_owner",
            role: "host",
            machineId: "0123456789abcdef",
            ticketId: "replace",
            expiresAt: Date.now() + 60000,
          }),
        },
      })
    );
    expect(upgraded.status).toBe(200);
    expect(opens()).toHaveLength(8);
    await denied(waiting);
    await denied(pending.result);
    await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
    host = replacement;
    await message({ type: "register", routeKey: key });
    expect(frames()).toContainEqual({ type: "registered" });
    expect(state.getWebSockets("tunnel")).toEqual([old, replacement]);
    const next = start();
    await message({ type: "file_head", streamId: next.id, status: 404, headers: {} }, old);
    await head(next.id, headers(1));
    expect((await next.result).status).toBe(200);
    await chunk(next.id, Uint8Array.of(99), old);
    await relay.webSocketClose(socket(old), 1000, "", true);
    await chunk(next.id, Uint8Array.of(42));
    await message({ type: "file_end", streamId: next.id });
    expect(new Uint8Array(await (await next.result).arrayBuffer())).toEqual(Uint8Array.of(42));
    const gone = start();
    host.readyState = 2; // workerd reports CLOSING on webSocketError.
    await relay.webSocketError(socket(host), new Error("disconnected"));
    await denied(gone.result);
    const count = opens().length;
    const afterError = fetchFile();
    expect(opens()).toHaveLength(count);
    await denied(afterError);
  });

  it("queues 32 after eight opens, removes cancelled waiters and promotes in FIFO order", async () => {
    const active = Array.from({ length: 8 }, () => start({ method: "HEAD" }));
    const abort = new AbortController();
    const waiting = Array.from({ length: 32 }, (_, index) =>
      fetchFile({
        method: "HEAD",
        headers: { range: `bytes=${index}-` },
        signal: index === 1 ? abort.signal : undefined,
      })
    );
    await denied(fetchFile());
    expect(opens()).toHaveLength(8);
    abort.abort();
    await denied(waiting[1]);
    const last = fetchFile({ method: "HEAD", headers: { range: "bytes=32-" } });
    await head(active[0].id, headers(2));
    for (const index of [...Array(33).keys()].filter((n) => n !== 1)) {
      const promoted = opens().at(-1)!;
      expect(promoted.range).toBe(`bytes=${index}-`);
      await head(promoted.streamId, headers(2));
      expect((await (waiting[index] ?? last)).status).toBe(200);
    }
  });

  it("counts the wait for a slot and the wait for a head against the same ten seconds", async () => {
    vi.useFakeTimers();
    const active = Array.from({ length: 8 }, () => start());
    for (const read of active) await head(read.id, headers(8));
    const expiresInQueue = fetchFile();
    await vi.advanceTimersByTimeAsync(10_000);
    await denied(expiresInQueue);
    expect(opens()).toHaveLength(8);
    const queued = fetchFile();
    await vi.advanceTimersByTimeAsync(9000);
    await (await active[0].result).body!.cancel();
    expect(opens()).toHaveLength(9);
    const ninth = opens().at(-1)!;
    await vi.advanceTimersByTimeAsync(1000);
    await denied(queued);
    expect(opens()).toHaveLength(9);
    expect(frames()).toContainEqual({ type: "file_cancel", streamId: ninth.streamId });
  });
});
