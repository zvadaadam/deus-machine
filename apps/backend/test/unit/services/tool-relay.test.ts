import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const { mockBroadcast } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
}));

vi.mock("../../../src/services/ws.service", () => ({
  broadcast: mockBroadcast,
}));

// ============================================================================
// Import after mocks
// ============================================================================

import {
  relay,
  resolve,
  reject,
  getPendingCount,
  clearAll,
} from "../../../src/services/agent/tool-relay";
import type { ToolRequestEvent } from "../../../../shared/agent-events";

// ============================================================================
// Helpers
// ============================================================================

function makeToolRequestEvent(overrides?: Partial<ToolRequestEvent>): ToolRequestEvent {
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
    it("broadcasts q:event tool:request to all WS clients", () => {
      const event = makeToolRequestEvent();
      const promise = relay(event);
      promise.catch(() => {}); // prevent unhandled rejection from afterEach clearAll

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame).toEqual({
        type: "q:event",
        event: "tool:request",
        data: {
          requestId: "req-1",
          sessionId: "sess-1",
          method: "getDiff",
          params: { sessionId: "sess-1", stat: true },
          timeoutMs: 5000,
        },
      });
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
