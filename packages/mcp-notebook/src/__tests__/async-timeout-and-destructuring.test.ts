import { describe, test, expect, beforeEach } from "bun:test";
import { PersistentVMContext } from "../vm-context.js";

describe("Bug fix: async timeout enforcement", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  test("await new Promise(() => {}) with timeout should reject", async () => {
    // A promise that never resolves — should hit the timeout
    const result = await ctx.execute("await new Promise(() => {})", {
      timeout: 200,
    });
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("timed out");
  });

  test("async long delay with timeout should reject", async () => {
    // A promise that resolves after 5 seconds, but timeout is 200ms
    const result = await ctx.execute(
      "await new Promise(resolve => setTimeout(resolve, 5000))",
      { timeout: 200 }
    );
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("timed out");
  });

  test("async code that resolves quickly should NOT timeout", async () => {
    const result = await ctx.execute(
      "await Promise.resolve(42)",
      { timeout: 5000 }
    );
    expect(result.error).toBeNull();
    expect(result.result).toBe("42");
  });

  test("sync code timeout is unaffected by the async fix", async () => {
    // Sync infinite loop should still timeout via vm.Script timeout
    const result = await ctx.execute("while(true) {}", { timeout: 200 });
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("timed out");
  });

  test("timer is cleaned up on success (no timer leaks)", async () => {
    // Run several quick async executions; if timers leaked we would
    // see spurious rejections or unhandled promise rejections.
    for (let i = 0; i < 10; i++) {
      const result = await ctx.execute(
        `await Promise.resolve(${i})`,
        { timeout: 5000 }
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe(String(i));
    }
  });
});

describe("Bug fix: nested destructuring parser", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  describe("nested object destructuring", () => {
    test("const { a: { b } } = obj — b should persist across async cells", async () => {
      const result1 = await ctx.execute(
        "const { a: { b } } = await Promise.resolve({ a: { b: 42 } })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("b");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("42");
    });

    test("triple-nested object: const { a: { b: { c } } } = obj", async () => {
      const result1 = await ctx.execute(
        "const { a: { b: { c } } } = await Promise.resolve({ a: { b: { c: 'deep' } } })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("c");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("deep");
    });

    test("nested object with default: const { a: { b = 10 } } = obj", async () => {
      const result1 = await ctx.execute(
        "const { a: { b = 10 } } = await Promise.resolve({ a: {} })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("b");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("10");
    });
  });

  describe("nested array destructuring", () => {
    test("const [x, [y, z]] = arr — all should persist", async () => {
      const result1 = await ctx.execute(
        "const [x, [y, z]] = await Promise.resolve([1, [2, 3]])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("x + y + z");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("6");
    });

    test("deeply nested array: const [a, [b, [c, d]]] = arr", async () => {
      const result1 = await ctx.execute(
        "const [a, [b, [c, d]]] = await Promise.resolve([1, [2, [3, 4]]])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("a + b + c + d");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("10");
    });

    test("nested array with rest: const [x, ...[y, z]] = arr", async () => {
      const result1 = await ctx.execute(
        "const [x, [y, ...rest]] = await Promise.resolve([1, [2, 3, 4]])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("x");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("1");

      const result3 = await ctx.execute("y");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("2");

      const result4 = await ctx.execute("rest");
      expect(result4.error).toBeNull();
      expect(result4.result).toContain("3");
      expect(result4.result).toContain("4");
    });
  });

  describe("declarations after nested destructuring survive (depth corruption fixed)", () => {
    test("const after nested object destructuring persists", async () => {
      const result1 = await ctx.execute(
        "const { a: { b } } = await Promise.resolve({ a: { b: 42 } })\nconst c = 5"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("c");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("5");

      const result3 = await ctx.execute("b");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("42");
    });

    test("const after nested array destructuring persists", async () => {
      const result1 = await ctx.execute(
        "const [x, [y, z]] = await Promise.resolve([1, [2, 3]])\nconst w = 99"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("w");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("99");
    });

    test("multiple declarations after nested destructuring all persist", async () => {
      const result1 = await ctx.execute(`
const { a: { b } } = await Promise.resolve({ a: { b: 42 } })
const c = 5
const d = b + c
let e = "hello"
      `);
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("b + c + d");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("94"); // 42 + 5 + 47

      const result3 = await ctx.execute("e");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("hello");
    });
  });

  describe("mixed nesting: object containing array and vice versa", () => {
    test("const { items: [first, second] } = obj", async () => {
      const result1 = await ctx.execute(
        "const { items: [first, second] } = await Promise.resolve({ items: ['a', 'b'] })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("first");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("a");

      const result3 = await ctx.execute("second");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("b");
    });

    test("const [{ name }, { name: name2 }] = arr", async () => {
      const result1 = await ctx.execute(
        "const [{ name }, { name: name2 }] = await Promise.resolve([{ name: 'Alice' }, { name: 'Bob' }])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("name");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("Alice");

      const result3 = await ctx.execute("name2");
      expect(result3.error).toBeNull();
      expect(result3.result).toBe("Bob");
    });

    test("const { data: { users: [first] } } = obj — deeply mixed nesting", async () => {
      const result1 = await ctx.execute(
        "const { data: { users: [first] } } = await Promise.resolve({ data: { users: ['Admin'] } })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("first");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("Admin");
    });
  });

  describe("flat destructuring still works (regression check)", () => {
    test("const { a, b } = obj still works", async () => {
      const result1 = await ctx.execute(
        "const { a, b } = await Promise.resolve({ a: 1, b: 2 })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("a + b");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("3");
    });

    test("const [a, b] = arr still works", async () => {
      const result1 = await ctx.execute(
        "const [a, b] = await Promise.resolve([10, 20])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("a + b");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("30");
    });

    test("const { name: userName } = obj — rename still works", async () => {
      const result1 = await ctx.execute(
        "const { name: userName } = await Promise.resolve({ name: 'Alice' })"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("userName");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("Alice");
    });

    test("const [head, ...tail] = arr — rest still works", async () => {
      const result1 = await ctx.execute(
        "const [head, ...tail] = await Promise.resolve([1, 2, 3])"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("head");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("1");

      const result3 = await ctx.execute("tail");
      expect(result3.error).toBeNull();
      expect(result3.result).toContain("2");
      expect(result3.result).toContain("3");
    });
  });
});
