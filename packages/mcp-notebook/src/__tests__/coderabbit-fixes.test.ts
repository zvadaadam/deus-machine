import { describe, test, expect, beforeEach } from "bun:test";
import { PersistentVMContext } from "../vm-context.js";

describe("CodeRabbit review fixes", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  describe("Issue 1: await detection inside template literals", () => {
    test("detects await inside template literal interpolation", async () => {
      const result = await ctx.execute(
        "const msg = `result: ${await Promise.resolve(42)}`\nmsg"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("result: 42");
    });

    test("detects await in template literal with multiple interpolations", async () => {
      const result = await ctx.execute(
        "const a = await Promise.resolve('hello')\nconst b = await Promise.resolve('world')\nconst msg = `${a} ${b}`\nmsg"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("hello world");
    });

    test("does not false-positive on 'await' inside a regular string", async () => {
      // 'await' in a string literal should NOT trigger async wrapping
      const result = await ctx.execute(
        'const msg = "the word await is just text"\nmsg'
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("the word await is just text");
    });

    test("does not false-positive on 'await' inside a template static part", async () => {
      const result = await ctx.execute(
        "const msg = `the word await is just text`\nmsg"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("the word await is just text");
    });

    test("await in template literal persists variables", async () => {
      const result1 = await ctx.execute(
        "const val = await Promise.resolve(99)\nconst label = `value is ${val}`"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("label");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("value is 99");
    });

    test("does not false-positive on 'await' inside a comment", async () => {
      const result = await ctx.execute(
        '// await something\nconst x = 10\nx'
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("10");
    });
  });

  describe("Issue 2: function/class declaration hoisting in async cells", () => {
    test("function declarations persist across async cells", async () => {
      const result1 = await ctx.execute(
        "await Promise.resolve()\nfunction helper() { return 42; }"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("helper()");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("42");
    });

    test("generator function declarations persist across async cells", async () => {
      const result1 = await ctx.execute(
        "await Promise.resolve()\nfunction* gen() { yield 1; yield 2; }"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("[...gen()]");
      expect(result2.error).toBeNull();
      expect(result2.result).toContain("1");
      expect(result2.result).toContain("2");
    });

    test("class declarations persist across async cells", async () => {
      const result1 = await ctx.execute(
        "await Promise.resolve()\nclass Point {\n  constructor(x, y) { this.x = x; this.y = y; }\n  sum() { return this.x + this.y; }\n}"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("new Point(3, 4).sum()");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("7");
    });

    test("function and const declarations both persist in same async cell", async () => {
      const result1 = await ctx.execute(
        "const data = await Promise.resolve([1,2,3])\nfunction total(arr) { return arr.reduce((a,b) => a+b, 0); }"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("total(data)");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("6");
    });

    test("class with extends persists across async cells", async () => {
      const result1 = await ctx.execute(
        "await Promise.resolve()\nclass Base { greet() { return 'hello'; } }\nclass Child extends Base { greet() { return super.greet() + ' world'; } }"
      );
      expect(result1.error).toBeNull();

      const result2 = await ctx.execute("new Child().greet()");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("hello world");
    });

    test("function inside a nested block is NOT hoisted (only top-level)", async () => {
      // Function declared inside an if block should not be hoisted
      const result1 = await ctx.execute(`
await Promise.resolve()
if (true) {
  function inner() { return 99; }
  console.log(inner())
}
      `);
      expect(result1.error).toBeNull();
      expect(result1.stdout).toContain("99");

      // inner should NOT be available in a subsequent cell (it was block-scoped)
      const result2 = await ctx.execute("typeof inner");
      expect(result2.error).toBeNull();
      expect(result2.result).toBe("undefined");
    });
  });

  describe("Issue 3: trailing semicolons in async expression wrapping", () => {
    test("trailing semicolon on last expression in async cell", async () => {
      const result = await ctx.execute(
        "await Promise.resolve()\n42;"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("42");
    });

    test("trailing semicolon with whitespace on last expression", async () => {
      const result = await ctx.execute(
        "await Promise.resolve()\n42;  "
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("42");
    });

    test("expression without semicolon still works", async () => {
      const result = await ctx.execute(
        "await Promise.resolve()\n42"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("42");
    });

    test("complex expression with trailing semicolon", async () => {
      const result = await ctx.execute(
        "const x = await Promise.resolve(10)\nx * 2 + 1;"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("21");
    });

    test("string expression with trailing semicolon", async () => {
      const result = await ctx.execute(
        "await Promise.resolve()\n'hello world';"
      );
      expect(result.error).toBeNull();
      expect(result.result).toBe("hello world");
    });

    test("function call expression with trailing semicolon", async () => {
      const result = await ctx.execute(
        "const arr = await Promise.resolve([3,1,2])\narr.sort();"
      );
      expect(result.error).toBeNull();
      // sort() returns the sorted array
      expect(result.result).toContain("1");
    });
  });
});
