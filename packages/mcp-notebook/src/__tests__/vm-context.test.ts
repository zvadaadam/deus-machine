import { describe, test, expect, beforeEach } from "bun:test";
import { PersistentVMContext } from "../vm-context.js";

describe("PersistentVMContext", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  describe("sync variable persistence", () => {
    test("const variables persist across cells", async () => {
      const result1 = await ctx.execute("const y = 100");
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("y + 1");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("101");
    });

    test("let variables persist across cells", async () => {
      const result1 = await ctx.execute("let counter = 0");
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("counter += 5\ncounter");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("5");
    });
  });

  describe("async variable persistence (IIFE hoisting)", () => {
    test("const with await persists across cells", async () => {
      const result1 = await ctx.execute(
        "const x = await Promise.resolve(42)"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("x");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("42");
    });

    test("let with await persists across cells", async () => {
      const result1 = await ctx.execute(
        "let val = await Promise.resolve('hello')"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("val");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("hello");
    });

    test("object destructuring with await persists", async () => {
      const result1 = await ctx.execute(
        "const { a, b } = await Promise.resolve({ a: 1, b: 2 })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("a + b");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("3");
    });

    test("array destructuring with await persists", async () => {
      const result1 = await ctx.execute(
        "const [first, second] = await Promise.resolve([10, 20])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("first + second");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("30");
    });

    test("multiple async declarations persist", async () => {
      const result1 = await ctx.execute(`
        const data = await Promise.resolve([1, 2, 3])
        const len = data.length
      `);
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("len");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("3");
    });

    test("async with expression return still persists variables", async () => {
      // Last line is an expression, so the IIFE returns it, but
      // earlier declarations should still be hoisted to context.
      const result1 = await ctx.execute(
        "const items = await Promise.resolve([1,2,3])\nitems.length"
      );
      expect(result1.error).toBeNull();
      expect(result1.result).toBe("3");

      // Now items should be available in the next cell
      const result2 = await ctx.execute("items");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("[\n  1,\n  2,\n  3\n]");
    });

    test("object destructuring with rename persists alias", async () => {
      const result1 = await ctx.execute(
        "const { name: userName } = await Promise.resolve({ name: 'Alice' })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("userName");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("Alice");
    });

    test("array destructuring with rest persists", async () => {
      const result1 = await ctx.execute(
        "const [head, ...tail] = await Promise.resolve([1, 2, 3, 4])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("head");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("1");

      const result3 = await ctx.execute("tail");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("[\n  2,\n  3,\n  4\n]");
    });

    test("chained async cells build on each other", async () => {
      // Cell 1: fetch data
      await ctx.execute("const nums = await Promise.resolve([10, 20, 30])");

      // Cell 2: derive from previous
      const result2 = await ctx.execute(
        "const sum = await Promise.resolve(nums.reduce((a, b) => a + b, 0))"
      );
      expect(result2.error).toBeNull();

      // Cell 3: use both
      const result3 = await ctx.execute("sum");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("60");
    });
  });

  describe("edge cases", () => {
    test("async code with no declarations does not error", async () => {
      const result = await ctx.execute(
        "await Promise.resolve(99)"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("99");
    });

    test("mixed sync and async cells share context", async () => {
      // Sync cell
      await ctx.execute("const base = 100");

      // Async cell referencing sync variable
      const result2 = await ctx.execute(
        "const doubled = await Promise.resolve(base * 2)"
      );
      expect(result2.error).toBeNull();

      // Sync cell referencing async variable
      const result3 = await ctx.execute("doubled + base");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("300");
    });
  });
});
