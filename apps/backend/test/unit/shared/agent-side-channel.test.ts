// The deus/* side channel: frame claiming (methods + id namespace), request
// round-trips with and without timeouts, error responses, and the transport
// filter that keeps claimed lines away from the upstream wire.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  filterClaimedLines,
  type LineTransport,
} from "@shared/agent-side-channel";

describe("SideChannelEndpoint", () => {
  let sentA: string[];
  let sentB: string[];
  let a: SideChannelEndpoint;
  let b: SideChannelEndpoint;

  /** Two endpoints wired back-to-back through in-memory line queues. */
  const pump = () => {
    // Deliver everything A sent to B, and vice versa, until quiescent.
    for (let i = 0; i < 10; i++) {
      const fromA = sentA.splice(0);
      const fromB = sentB.splice(0);
      if (!fromA.length && !fromB.length) return;
      for (const line of fromA) b.handleLine(line);
      for (const line of fromB) a.handleLine(line);
    }
  };

  beforeEach(() => {
    sentA = [];
    sentB = [];
    a = new SideChannelEndpoint((line) => sentA.push(line), "a");
    b = new SideChannelEndpoint((line) => sentB.push(line), "b");
  });

  it("round-trips a request/response pair", async () => {
    b.onRequest(SIDE_CHANNEL.getDiff, (params) => ({ echoed: params }));
    const promise = a.request(SIDE_CHANNEL.getDiff, { sessionId: "s1" }, 1000);
    pump();
    await Promise.resolve();
    pump();
    await expect(promise).resolves.toEqual({ echoed: { sessionId: "s1" } });
  });

  it("propagates handler throws as rejected requests", async () => {
    b.onRequest(SIDE_CHANNEL.getDiff, () => {
      throw new Error("diff unavailable");
    });
    const promise = a.request(SIDE_CHANNEL.getDiff, {}, 1000);
    pump();
    await Promise.resolve();
    pump();
    await expect(promise).rejects.toThrow("diff unavailable");
  });

  it("answers unknown side-channel methods with an error", async () => {
    const promise = a.request("deus/nope", {}, 1000);
    pump();
    await Promise.resolve();
    pump();
    await expect(promise).rejects.toThrow("unknown side-channel method");
  });

  it("times out when the peer never answers", async () => {
    vi.useFakeTimers();
    try {
      const promise = a.request(SIDE_CHANNEL.getDiff, {}, 50);
      promise.catch(() => {});
      vi.advanceTimersByTime(60);
      await expect(promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers notifications without a response", () => {
    const seen: unknown[] = [];
    b.onNotification(SIDE_CHANNEL.title, (params) => seen.push(params));
    a.notify(SIDE_CHANNEL.title, { sessionId: "s1", agentHarness: "claude", title: "Hi" });
    pump();
    expect(seen).toEqual([{ sessionId: "s1", agentHarness: "claude", title: "Hi" }]);
    expect(sentB).toEqual([]); // no response frame
  });

  it("claims only deus frames: upstream requests, responses, and events pass through", () => {
    expect(a.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start" }))).toBe(
      false
    );
    expect(a.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: 1 } }))).toBe(false);
    expect(
      a.handleLine(
        JSON.stringify({ jsonrpc: "2.0", method: "event", params: { sessionId: "s", seq: 1 } })
      )
    ).toBe(false);
    expect(a.handleLine("not json at all")).toBe(false);
    // Claimed: deus method frames and deus: id responses.
    expect(
      a.handleLine(JSON.stringify({ jsonrpc: "2.0", method: SIDE_CHANNEL.hello, params: {} }))
    ).toBe(true);
    expect(a.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "deus:99", result: null }))).toBe(
      true
    );
  });

  it("failPending rejects all in-flight requests", async () => {
    const p1 = a.request(SIDE_CHANNEL.getDiff, {});
    const p2 = a.request(SIDE_CHANNEL.getTerminalOutput, {});
    a.failPending("connection closed");
    await expect(p1).rejects.toThrow("connection closed");
    await expect(p2).rejects.toThrow("connection closed");
  });
});

describe("filterClaimedLines", () => {
  it("hides claimed lines from the inner handler and passes the rest", () => {
    const lines: string[] = [];
    let push: (line: string) => void = () => {};
    const inner: LineTransport = {
      send: () => {},
      onLine: (handler) => {
        push = handler;
        return () => {};
      },
      onClose: () => () => {},
      close: () => {},
      closed: false,
    };
    const filtered = filterClaimedLines(inner, (line) => line.includes("deus/"));
    filtered.onLine((line) => lines.push(line));
    push(JSON.stringify({ jsonrpc: "2.0", method: "deus/hello" }));
    push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("turn/start");
  });
});
