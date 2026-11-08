import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tickets = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/platform/ws/relay-access", () => ({
  fetchRelayTicket: tickets.fetch,
  relayProtocols: (ticket: string) => ["deus.relay.v2", ticket],
}));

import { pairDevice, type PairingTarget } from "@/features/auth/api/pairing-client";

const account = { accountId: "user_a", bearer: "session" };
const relay: PairingTarget = {
  kind: "relay",
  baseUrl: "wss://relay.test",
  serverId: "host A",
  account,
};
const direct: PairingTarget = { kind: "direct", baseUrl: "https://mac.test" };
class Socket {
  static all: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    Socket.all.push(this);
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const fetchMock = vi.fn<typeof fetch>();
const pair = (target = relay, signal = new AbortController().signal) =>
  pairDevice(target, "ABLE ACID", "Phone", signal);
/** Relay pairing asks Deus Cloud for a ticket before it dials. */
async function dialed(): Promise<Socket> {
  await vi.waitFor(() => expect(Socket.all.length).toBeGreaterThan(0));
  return Socket.all.at(-1)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  fetchMock.mockReset();
  tickets.fetch.mockReset().mockResolvedValue("ticket-1");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one-shot relay enrollment", () => {
  it("returns the grant once, binds the host and closes all handlers", async () => {
    const result = pair();
    const socket = await dialed();
    expect(tickets.fetch).toHaveBeenCalledWith(account, "host A", expect.any(AbortSignal));
    expect(socket.url).toBe("wss://relay.test/api/servers/host%20A/pair");
    expect(socket.protocols).toEqual(["deus.relay.v2", "ticket-1"]);
    socket.onopen?.();
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: "pair_request", code: "ABLE ACID", deviceName: "Phone" })
    );
    socket.message({ type: "pair_success", token: "grant" });
    expect(await result).toEqual({ token: "grant", deviceName: "Phone" });
    expect(socket.close).toHaveBeenCalledOnce();
    expect([socket.onopen, socket.onmessage, socket.onclose, socket.onerror]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it.each([1000, 1006, 1013])(
    "settles a close without a reply, including code %s",
    async (code) => {
      const result = pair();
      const rejected = expect(result).rejects.toThrow("before pairing finished");
      (await dialed()).onclose?.({ code });
      await rejected;
      expect(Socket.all).toHaveLength(1);
    }
  );

  it("bounds slow handshakes without automatically consuming the code again", async () => {
    const result = pair();
    const rejected = expect(result).rejects.toThrow("Pairing timed out");
    await dialed();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(Socket.all).toHaveLength(1);
    expect(Socket.all[0].close).toHaveBeenCalledOnce();
  });

  it("ignores late success after cancellation", async () => {
    const abort = new AbortController();
    const result = pair(relay, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    const late = (await dialed()).onmessage;
    abort.abort();
    late?.({ data: JSON.stringify({ type: "pair_success", token: "old-host-secret" }) });
    await rejected;
    expect(Socket.all[0].close).toHaveBeenCalledOnce();
  });

  it.each([relay, direct])("starts no transport if already cancelled ($kind)", async (target) => {
    const abort = new AbortController();
    abort.abort();
    await expect(pair(target, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(Socket.all).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { type: "pair_success", token: 123 },
    { type: "pair_success", token: "" },
    { type: "pair_success", token: "   " },
    { type: "unrelated", token: "grant" },
    null,
  ])("rejects malformed grants: %j", async (frame) => {
    const result = pair();
    (await dialed()).message(frame);
    await expect(result).rejects.toThrow("Unexpected pairing response");
  });

  it("preserves actionable rejection messages", async () => {
    const result = pair();
    (await dialed()).message({ type: "pair_failed", message: "Too many failed attempts" });
    await expect(result).rejects.toThrow("Too many failed attempts");
  });

  it.each(["send", "error", "json"])("cleans up a %s failure", async (failure) => {
    const result = pair();
    const socket = await dialed();
    if (failure === "send") {
      socket.send.mockImplementation(() => {
        throw new Error("closed");
      });
      socket.onopen?.();
    } else if (failure === "error") socket.onerror?.();
    else socket.onmessage?.({ data: "{" });
    await expect(result).rejects.toThrow();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

describe("relay tickets", () => {
  it("reports a refused ticket without dialing", async () => {
    tickets.fetch.mockRejectedValue(new Error("This computer is not connected to your account."));
    await expect(pair()).rejects.toThrow("not connected to your account");
    expect(Socket.all).toHaveLength(0);
  });

  it("does not dial after leaving the host while the ticket was in flight", async () => {
    let issue!: (ticket: string) => void;
    tickets.fetch.mockReturnValue(new Promise((resolve) => (issue = resolve)));
    const abort = new AbortController();
    const result = pair(relay, abort.signal);
    abort.abort();
    issue("late-ticket");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(Socket.all).toHaveLength(0);
  });
});

describe("direct enrollment", () => {
  it("uses the same grant shape and validates the response before storing anything", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ token: "direct-grant", device: { name: "Tablet" } })
    );
    expect(await pair(direct)).toEqual({ token: "direct-grant", deviceName: "Tablet" });
    expect(fetchMock).toHaveBeenCalledWith("https://mac.test/api/remote-auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ABLE ACID", deviceName: "Phone" }),
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["timeout", "abort"])("cancels a stalled HTTP request on %s", async (event) => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        })
    );
    const abort = new AbortController();
    const result = pair(direct, abort.signal);
    const rejected = expect(result).rejects.toThrow(
      event === "timeout" ? "Pairing timed out" : "aborted"
    );
    if (event === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    else abort.abort();
    await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not admit a late HTTP response after leaving the host", async () => {
    let reply!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve;
      })
    );
    const abort = new AbortController();
    const result = pair(direct, abort.signal);
    abort.abort();
    reply(Response.json({ token: "old-host-secret" }));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the deadline active while waiting for the HTTP response body", async () => {
    fetchMock.mockImplementation(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options?.signal?.addEventListener(
                "abort",
                () => controller.error(options.signal?.reason),
                { once: true }
              );
            },
          })
        )
    );
    const result = pair(direct);
    const rejected = expect(result).rejects.toThrow("Pairing timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it.each([
    [200, { token: {} }, "Unexpected pairing response"],
    [429, { error: "Too many failed attempts" }, "Too many failed attempts"],
    [500, { error: {} }, "Invalid or expired connection code"],
  ])("rejects invalid HTTP grants (%s)", async (status, body, message) => {
    fetchMock.mockResolvedValue(Response.json(body, { status }));
    await expect(pair(direct)).rejects.toThrow(message);
  });
});
