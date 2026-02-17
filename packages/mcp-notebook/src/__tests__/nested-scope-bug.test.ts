import { describe, test, expect, beforeEach } from "bun:test";
import { PersistentVMContext } from "../vm-context.js";

describe("extractDeclaredNames nested scope bug", () => {
  let ctx: PersistentVMContext;

  beforeEach(() => {
    ctx = new PersistentVMContext();
  });

  test("async code with const inside .map() callback should NOT crash", async () => {
    const result = await ctx.execute(`
const data = await Promise.resolve([{name: "alice"}, {name: "bob"}])
const names = data.map(item => {
  const upper = item.name.toUpperCase()
  return upper
})
names
    `);
    expect(result.error).toBeNull();
    expect(result.result).toContain("ALICE");
    expect(result.result).toContain("BOB");
  });

  test("async code with const inside if block should NOT crash", async () => {
    const result = await ctx.execute(`
const flag = await Promise.resolve(true)
if (flag) {
  const msg = "hello"
  console.log(msg)
}
    `);
    expect(result.error).toBeNull();
    expect(result.stdout).toContain("hello");
  });

  test("async code with const inside for...of should NOT crash", async () => {
    const result = await ctx.execute(`
const items = await Promise.resolve([1, 2, 3])
for (const item of items) {
  const doubled = item * 2
  console.log(doubled)
}
    `);
    expect(result.error).toBeNull();
    expect(result.stdout).toEqual(["2", "4", "6"]);
  });

  test("async code with const inside try/catch should NOT crash", async () => {
    const result = await ctx.execute(`
const data = await Promise.resolve("test")
try {
  const parsed = JSON.parse('"' + data + '"')
  console.log(parsed)
} catch (e) {
  const errMsg = e.message
  console.log(errMsg)
}
    `);
    expect(result.error).toBeNull();
    expect(result.stdout).toContain("test");
  });

  test("nested arrow functions (depth > 1) should not leak inner vars", async () => {
    const result = await ctx.execute(`
const arr = await Promise.resolve([1, 2, 3])
const x = await Promise.resolve(arr.map(i => {
  const y = i * 10
  return y
}))
x
    `);
    expect(result.error).toBeNull();
    expect(result.result).toContain("10");
    expect(result.result).toContain("20");
    expect(result.result).toContain("30");

    // Verify top-level vars persisted
    const result2 = await ctx.execute("arr.length + x.length");
    expect(result2.error).toBeNull();
    expect(result2.result).toBe("6");
  });

  test("string containing 'const' should not be extracted", async () => {
    const result = await ctx.execute(`
const msg = await Promise.resolve("the const keyword is reserved")
msg
    `);
    expect(result.error).toBeNull();
    expect(result.result).toContain("const keyword");

    // msg should persist (it's a real top-level declaration)
    const result2 = await ctx.execute("msg");
    expect(result2.error).toBeNull();
    expect(result2.result).toContain("const keyword");
  });

  test("comment containing 'const' should not be extracted", async () => {
    const result = await ctx.execute(`
// const fake = "should not be extracted"
/* const alsoFake = "likewise" */
const real = await Promise.resolve(42)
real
    `);
    expect(result.error).toBeNull();
    expect(result.result).toBe("42");

    // real should persist, but fake and alsoFake should NOT exist
    const result2 = await ctx.execute("real");
    expect(result2.error).toBeNull();
    expect(result2.result).toBe("42");

    const result3 = await ctx.execute("typeof fake");
    expect(result3.error).toBeNull();
    expect(result3.result).toBe("undefined");

    const result4 = await ctx.execute("typeof alsoFake");
    expect(result4.error).toBeNull();
    expect(result4.result).toBe("undefined");
  });

  test("top-level declarations still persist in async context", async () => {
    const result = await ctx.execute(`
const a = await Promise.resolve(1)
const b = await Promise.resolve(2)
let c = a + b
    `);
    expect(result.error).toBeNull();

    const result2 = await ctx.execute("a + b + c");
    expect(result2.error).toBeNull();
    expect(result2.result).toBe("6");
  });
});
