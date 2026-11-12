import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockPublish = vi.hoisted(() => vi.fn());

vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));

// ============================================================================
// Import after mocks
// ============================================================================

import {
  relay,
  resolve,
  reject,
  getPendingCount,
  clearAll,
  cancelRelay,
  cancelSessionRelays,
} from "../../../src/services/agent/tool-relay";
// The live payload type. `shared/agent-events` was the deus dialect and is
// deleted; this test kept importing it because the backend tests were not in
// any tsconfig, so nothing checked the reference.
import type { ToolRequestEventData } from "@shared/types/query-protocol";
import { toolRequests } from "@shared/api/sessions";
import { published } from "../../helpers";

// ============================================================================
// Helpers
// ============================================================================

function makeToolRequestEvent(
  overrides?: Partial<ToolRequestEventData>
): ToolRequestEventData & { type: string } {
  return {
    type: "tool.request",
    requestId: "req-1",
    sessionId: "sess-1",
    method: "getDiff",
    params: { sessionId: "sess-1", stat: true },
    timeoutMs: 5000,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ToolRelay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // clearAll rejects pending promises — swallow them to avoid unhandled rejection noise
    try {
      clearAll();
    } catch {}
    vi.useRealTimers();
  });

  // ==========================================================================
  // relay()
  // ==========================================================================

  describe("relay", () => {
    it("publishes the request to the clients following that chat, and nowhere else", () => {
      const event = makeToolRequestEvent();
      const promise = relay(event);
      promise.catch(() => {}); // prevent unhandled rejection from afterEach clearAll

      // One publish in all, on `toolRequests`, under the asking chat's scope.
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(published(mockPublish, toolRequests)).toEqual([
        {
          scope: { sessionId: "sess-1" },
          event: {
            type: "request",
            request: {
              requestId: "req-1",
              sessionId: "sess-1",
              method: "getDiff",
              params: { sessionId: "sess-1", stat: true },
              timeoutMs: 5000,
            },
          },
        },
      ]);
    });

    it("publishes each chat's request under its own scope", () => {
      relay(makeToolRequestEvent({ requestId: "r1", sessionId: "sess-1" })).catch(() => {});
      relay(makeToolRequestEvent({ requestId: "r2", sessionId: "sess-2" })).catch(() => {});

      expect(
        published(mockPublish, toolRequests).map(({ scope, event }) => [
          scope,
          event.type === "request" ? event.request.requestId : event.type,
        ])
      ).toEqual([
        [{ sessionId: "sess-1" }, "r1"],
        [{ sessionId: "sess-2" }, "r2"],
      ]);
    });

    it("increments pending count", () => {
      expect(getPendingCount()).toBe(0);
      const promise = relay(makeToolRequestEvent());
      promise.catch(() => {}); // prevent unhandled rejection from afterEach clearAll
      expect(getPendingCount()).toBe(1);
    });

    it("resolves when resolve() is called with the requestId", async () => {
      const event = makeToolRequestEvent();
      const promise = relay(event);

      resolve("req-1", { diff: "file.ts: +10 -5" });

      await expect(promise).resolves.toEqual({ diff: "file.ts: +10 -5" });
      expect(getPendingCount()).toBe(0);
    });

    it("rejects when reject() is called with the requestId", async () => {
      const event = makeToolRequestEvent();
      const promise = relay(event);

      reject("req-1", "No workspace context");

      await expect(promise).rejects.toThrow("No workspace context");
      expect(getPendingCount()).toBe(0);
    });

    it("rejects on timeout", async () => {
      const event = makeToolRequestEvent({ timeoutMs: 3000 });
      const promise = relay(event);

      // Advance past the timeout
      vi.advanceTimersByTime(3001);

      await expect(promise).rejects.toThrow("Tool relay timed out after 3000ms");
      expect(getPendingCount()).toBe(0);
    });

    it("does not reject before timeout", async () => {
      const event = makeToolRequestEvent({ timeoutMs: 5000 });
      const promise = relay(event);
      // Attach a catch handler to prevent unhandled rejection when afterEach clears
      promise.catch(() => {});

      vi.advanceTimersByTime(4999);

      // Still pending
      expect(getPendingCount()).toBe(1);
    });

    it("supersedes existing pending request with same requestId", async () => {
      const event1 = makeToolRequestEvent({ requestId: "dup-1" });
      const promise1 = relay(event1);

      const event2 = makeToolRequestEvent({ requestId: "dup-1", method: "browserSnapshot" });
      const promise2 = relay(event2);

      // First promise should have been rejected
      await expect(promise1).rejects.toThrow("Superseded");

      // Second should still be pending
      expect(getPendingCount()).toBe(1);

      // Resolve the second one
      resolve("dup-1", { snapshot: "ok" });
      await expect(promise2).resolves.toEqual({ snapshot: "ok" });
    });

    it("handles multiple concurrent relays", async () => {
      const p1 = relay(makeToolRequestEvent({ requestId: "r1", method: "getDiff" }));
      const p2 = relay(makeToolRequestEvent({ requestId: "r2", method: "browserSnapshot" }));
      const p3 = relay(makeToolRequestEvent({ requestId: "r3", method: "getTerminalOutput" }));

      expect(getPendingCount()).toBe(3);

      resolve("r2", { snapshot: "dom-tree" });
      resolve("r1", { diff: "changes" });
      reject("r3", "Terminal not available");

      await expect(p1).resolves.toEqual({ diff: "changes" });
      await expect(p2).resolves.toEqual({ snapshot: "dom-tree" });
      await expect(p3).rejects.toThrow("Terminal not available");
      expect(getPendingCount()).toBe(0);
    });
  });

  // ==========================================================================
  // resolve() / reject()
  // ==========================================================================

  describe("resolve", () => {
    it("returns true when requestId is found", () => {
      relay(makeToolRequestEvent({ requestId: "found" }));
      expect(resolve("found", "ok")).toBe(true);
    });

    it("returns false when requestId is not found", () => {
      expect(resolve("nonexistent", "ok")).toBe(false);
    });

    it("clears the timeout timer on resolve", async () => {
      const event = makeToolRequestEvent({ requestId: "timer-test", timeoutMs: 1000 });
      const promise = relay(event);

      resolve("timer-test", "result");
      await promise;

      // Advance past the original timeout — should not throw
      vi.advanceTimersByTime(2000);
      expect(getPendingCount()).toBe(0);
    });
  });

  describe("reject", () => {
    it("returns true when requestId is found", async () => {
      const promise = relay(makeToolRequestEvent({ requestId: "found" }));
      expect(reject("found", "error")).toBe(true);
      // Must await the rejected promise to avoid unhandled rejection
      await expect(promise).rejects.toThrow("error");
    });

    it("returns false when requestId is not found", () => {
      expect(reject("nonexistent", "error")).toBe(false);
    });
  });

  // ==========================================================================
  // clearAll()
  // ==========================================================================

  describe("clearAll", () => {
    it("rejects all pending relays", async () => {
      const p1 = relay(makeToolRequestEvent({ requestId: "c1" }));
      const p2 = relay(makeToolRequestEvent({ requestId: "c2" }));

      clearAll();

      await expect(p1).rejects.toThrow("Tool relay cleared");
      await expect(p2).rejects.toThrow("Tool relay cleared");
      expect(getPendingCount()).toBe(0);
    });
  });
});

describe("cancelSessionRelays", () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });
  afterEach(() => {
    clearAll();
  });

  it("rejects the session's pending relays, publishes a cancel for each to that chat's clients, leaves other sessions alone", async () => {
    const mine = relay(makeToolRequestEvent({ requestId: "q-1", sessionId: "sess-1" }));
    const second = relay(makeToolRequestEvent({ requestId: "q-3", sessionId: "sess-1" }));
    const other = relay(makeToolRequestEvent({ requestId: "q-2", sessionId: "sess-2" }));
    mine.catch(() => {});
    second.catch(() => {});
    other.catch(() => {});
    mockPublish.mockClear();

    expect(cancelSessionRelays("sess-1", "turn ended")).toEqual(["q-1", "q-3"]);

    await expect(mine).rejects.toThrow(/cancelled: turn ended/);
    await expect(second).rejects.toThrow(/cancelled: turn ended/);
    expect(getPendingCount()).toBe(1);
    // Nothing was published but the two cancels, and nothing under sess-2's scope.
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(published(mockPublish, toolRequests)).toEqual([
      {
        scope: { sessionId: "sess-1" },
        event: { type: "cancel", sessionId: "sess-1", requestId: "q-1" },
      },
      {
        scope: { sessionId: "sess-1" },
        event: { type: "cancel", sessionId: "sess-1", requestId: "q-3" },
      },
    ]);
    // The other session's relay is untouched and still resolvable.
    expect(resolve("q-2", { ok: true })).toBe(true);
    await expect(other).resolves.toEqual({ ok: true });
  });
});

describe("cancelRelay", () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });
  afterEach(() => {
    clearAll();
  });

  it("rejects one pending relay and tells that chat's clients to drop its overlay", async () => {
    const asked = relay(makeToolRequestEvent({ requestId: "q-1", sessionId: "sess-1" }));
    asked.catch(() => {});
    mockPublish.mockClear();

    expect(cancelRelay("q-1", "resolved elsewhere")).toBe(true);
    await expect(asked).rejects.toThrow(/cancelled: resolved elsewhere/);
    expect(getPendingCount()).toBe(0);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(published(mockPublish, toolRequests)).toEqual([
      {
        scope: { sessionId: "sess-1" },
        event: { type: "cancel", sessionId: "sess-1", requestId: "q-1" },
      },
    ]);
    // Already gone: nothing is cancelled, and nothing more is published.
    expect(cancelRelay("q-1", "again")).toBe(false);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
