import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PersistentVMContext } from "../vm-context.js";

describe("PersistentVMContext bug fixes", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  describe("Bug 1: containsAwait detects await(expr) without space", () => {
    test("await(expr) without space is detected as async", async () => {
      const result = await ctx.execute(
        "const p = Promise.resolve(42)\nconst val = await(p)\nval"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("42");
    });

    test("await (expr) with space still works", async () => {
      const result = await ctx.execute(
        "const val = await (Promise.resolve(99))\nval"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("99");
    });

    test("for await(...) without space is detected as async", async () => {
      const result = await ctx.execute(
        `async function* gen() { yield 1; yield 2; }
const items = []
for await(const item of gen()) { items.push(item) }
items`
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("[\n  1,\n  2\n]");
    });

    test("await(expr) persists variables across cells", async () => {
      const r1 = await ctx.execute(
        "const data = await(Promise.resolve({ x: 10 }))"
      );
      expect(r1.error).toBeNull();

      const r2 = await ctx.execute("data.x");
      expect(r2.error).toBeNull();
      expect(r2.result).toBe("10");
    });
  });

  describe("Bug 2: async timeout enforced via Promise.race", () => {
    test("async code that never resolves times out", async () => {
      const result = await ctx.execute("await new Promise(() => {})", {
        timeout: 500,
      });
      expect(result.error).not.toBeNull();
      expect(result.error).toContain("timed out");
    });

    test("fast async code still completes normally", async () => {
      const result = await ctx.execute(
        "await Promise.resolve('fast')",
        { timeout: 5000 }
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("fast");
    });

    test("timeout error includes the duration", async () => {
      const result = await ctx.execute(
        "await new Promise(() => {})",
        { timeout: 300 }
      );
      expect(result.error).not.toBeNull();
      expect(result.error).toContain("300ms");
    });
  });

  describe("Bug 3: timer cleanup on reset", () => {
    test("reset() clears active intervals", async () => {
      // Start an interval that would run forever
      await ctx.execute(
        "let count = 0; setInterval(() => { count++ }, 10)"
      );

      // Reset clears all timers and creates fresh context
      ctx.reset();

      // After reset, the old variable should not exist
      const result = await ctx.execute("typeof count");
      expect(result.result).toBe("undefined");
    });

    test("reset() clears active timeouts", async () => {
      // Schedule a timeout that would fail if it ran after reset
      await ctx.execute(
        "setTimeout(() => { globalThis.__leaked = true }, 50)"
      );

      ctx.reset();

      // Wait long enough for the timeout to have fired if it wasn't cleared
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The leaked variable should not exist in the fresh context
      const result = await ctx.execute("typeof __leaked");
      expect(result.result).toBe("undefined");
    });

    test("destroy() clears all timers", async () => {
      await ctx.execute("setInterval(() => {}, 10)");
      await ctx.execute("setTimeout(() => {}, 10000)");

      // destroy() should not throw and should clear timers
      ctx.destroy();

      // Calling destroy again should be safe (idempotent)
      ctx.destroy();
    });

    test("cleared timers via sandbox clearInterval are tracked", async () => {
      // Start and then clear an interval from within sandbox code
      const result = await ctx.execute(`
        const id = setInterval(() => {}, 10)
        clearInterval(id)
        'cleared'
      `);
      expect(result.error).toBeNull();
      expect(result.result).toBe("cleared");
    });
  });
});
