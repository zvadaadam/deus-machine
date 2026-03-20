// sidecar/agents/async-queue.ts
// Go-channel-style async queue: single producer, single consumer.
// Push items, close when done, consume with for-await-of.
//
// Ported from Stockholm v3's async-queue.ts, adapted for our needs:
// - push-after-close returns false (silent drop) instead of throwing,
//   because sendMessage() can race with terminateSession() during rapid
//   re-query scenarios.
// - Constructor accepts optional initial items for pre-seeded buffers.

/**
 * Single-consumer async channel with Go-channel semantics.
 *
 * - push(): enqueue an item. Returns false (no-op) if already closed.
 * - close(): signal end-of-stream. Subsequent pushes are silently dropped.
 * - [Symbol.asyncIterator]: yields items until closed AND drained.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  constructor(initialItems?: T[]) {
    if (initialItems) {
      this.buffer.push(...initialItems);
    }
  }

  /**
   * Enqueue an item. If a consumer is waiting, it receives the value
   * immediately. Otherwise the value is buffered.
   *
   * Returns true if accepted, false if closed (silently dropped).
   */
  push(item: T): boolean {
    if (this.closed) return false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
    return true;
  }

  /**
   * Signal end-of-stream. Any waiting consumer receives done: true.
   * Subsequent push() calls return false. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Fast path: buffered items
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        // Closed and drained
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        // Wait for next push() or close()
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
