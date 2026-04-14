import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../agents/async-queue";

// ── Helpers ────────────────────────────────────────────────────────────────

async function collectItems<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

async function expectNextValue<T>(iter: AsyncIterator<T>, value: T): Promise<void> {
  expect(await iter.next()).toEqual({ value, done: false });
}

async function expectDone<T>(iter: AsyncIterator<T>): Promise<void> {
  expect((await iter.next()).done).toBe(true);
}

describe("AsyncQueue", () => {
  // ==========================================================================
  // Push + consume
  // ==========================================================================

  it("delivers items in FIFO order", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    expect(await collectItems(q)).toEqual([1, 2, 3]);
  });

  it("consumer waits for push when buffer is empty", async () => {
    const q = new AsyncQueue<string>();

    // Start consuming (will block until push)
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();

    // Push after a microtask
    await Promise.resolve();
    q.push("hello");

    const result = await pending;
    expect(result).toEqual({ value: "hello", done: false });

    q.close();
  });

  it("constructor accepts initial items", async () => {
    const q = new AsyncQueue<string>(["a", "b"]);
    q.close();

    expect(await collectItems(q)).toEqual(["a", "b"]);
  });

  // ==========================================================================
  // Push after close
  // ==========================================================================

  it("push after close returns false (silently dropped)", () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();

    const accepted = q.push(2);
    expect(accepted).toBe(false);
  });

  it("push before close returns true", () => {
    const q = new AsyncQueue<number>();
    expect(q.push(1)).toBe(true);
    q.close();
  });

  // ==========================================================================
  // Close behavior
  // ==========================================================================

  it("close unblocks a waiting consumer with done: true", async () => {
    const q = new AsyncQueue<number>();

    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();

    q.close();

    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("close with buffered items: drains buffer before signaling done", async () => {
    const q = new AsyncQueue<string>();
    q.push("x");
    q.push("y");
    q.close();

    const iter = q[Symbol.asyncIterator]();
    await expectNextValue(iter, "x");
    await expectNextValue(iter, "y");
    await expectDone(iter);
  });

  it("multiple close calls are idempotent", () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.close();
    q.close();
    expect(q.isClosed).toBe(true);
  });

  // ==========================================================================
  // isClosed
  // ==========================================================================

  it("isClosed reflects state", () => {
    const q = new AsyncQueue<number>();
    expect(q.isClosed).toBe(false);
    q.close();
    expect(q.isClosed).toBe(true);
  });

  // ==========================================================================
  // for-await-of end-to-end
  // ==========================================================================

  it("for-await-of collects all items then exits on close", async () => {
    const q = new AsyncQueue<number>();

    // Simulate async producer
    const producer = (async () => {
      q.push(10);
      await Promise.resolve();
      q.push(20);
      await Promise.resolve();
      q.push(30);
      q.close();
    })();

    const items = await collectItems(q);
    await producer;
    expect(items).toEqual([10, 20, 30]);
  });

  it("empty queue closed immediately yields no items", async () => {
    const q = new AsyncQueue<number>();
    q.close();

    expect(await collectItems(q)).toEqual([]);
  });

  // ==========================================================================
  // Interleaving
  // ==========================================================================

  it("push and close in same microtask: item is delivered before done", async () => {
    const q = new AsyncQueue<string>();
    q.push("msg");
    q.close();

    const iter = q[Symbol.asyncIterator]();
    await expectNextValue(iter, "msg");
    await expectDone(iter);
  });
});
