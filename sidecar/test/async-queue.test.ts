import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../agents/async-queue";

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

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
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

    const items: string[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual(["a", "b"]);
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

    const r1 = await iter.next();
    expect(r1).toEqual({ value: "x", done: false });

    const r2 = await iter.next();
    expect(r2).toEqual({ value: "y", done: false });

    const r3 = await iter.next();
    expect(r3.done).toBe(true);
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

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }

    await producer;
    expect(items).toEqual([10, 20, 30]);
  });

  it("empty queue closed immediately yields no items", async () => {
    const q = new AsyncQueue<number>();
    q.close();

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });

  // ==========================================================================
  // Interleaving
  // ==========================================================================

  it("push and close in same microtask: item is delivered before done", async () => {
    const q = new AsyncQueue<string>();
    q.push("msg");
    q.close();

    const iter = q[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1).toEqual({ value: "msg", done: false });

    const r2 = await iter.next();
    expect(r2.done).toBe(true);
  });
});
