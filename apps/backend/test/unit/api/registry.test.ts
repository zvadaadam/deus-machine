import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { live, out, read, write } from "@shared/api/op";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";

const greet = read({
  name: "greet",
  input: z.object({ name: z.string().min(1), loud: z.boolean().default(false) }),
  output: out<string>(),
});
const rename = write({ name: "rename", input: z.object({ to: z.string() }), output: out<void>() });
const count = live({ name: "count", output: out<number>() });
const ctx = { caller: LOCAL_CALLER };

function registry() {
  const renamed = vi.fn();
  return {
    renamed,
    registry: new Registry([
      handle(greet, ({ name, loud }) => (loud ? `HELLO ${name}` : `hello ${name}`)),
      handle(rename, ({ to }) => renamed(to)),
      handle(count, () => 3),
    ]),
  };
}

describe("operation registry", () => {
  it("validates the input, applies defaults and runs the handler", async () => {
    const { registry: ops } = registry();
    expect(await ops.run("greet", "read", { name: "Ada" }, ctx)).toBe("hello Ada");
    expect(await ops.run("greet", "read", { name: "Ada", loud: true }, ctx)).toBe("HELLO Ada");
  });

  it("names the missing parameter, and never runs the handler on bad input", async () => {
    const { registry: ops, renamed } = registry();
    await expect(ops.run("greet", "read", {}, ctx)).rejects.toMatchObject({
      statusCode: 400,
      message: "greet requires name",
    });
    await expect(ops.run("greet", "read", undefined, ctx)).rejects.toMatchObject({
      message: "greet requires name",
    });
    await expect(ops.run("greet", "read", { name: "" }, ctx)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("greet: name:"),
    });
    await expect(ops.run("rename", "write", { to: 7 }, ctx)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(renamed).not.toHaveBeenCalled();
  });

  it("refuses an operation that does not exist", async () => {
    const { registry: ops } = registry();
    await expect(ops.run("nope", "read", {}, ctx)).rejects.toMatchObject({
      statusCode: 404,
      message: "Unknown operation: nope",
    });
  });

  it("refuses a write sent as a read, and a read sent as a write", async () => {
    const { registry: ops, renamed } = registry();
    await expect(ops.run("rename", "read", { to: "x" }, ctx)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(ops.run("greet", "write", { name: "Ada" }, ctx)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(renamed).not.toHaveBeenCalled();
  });

  it("answers a live read in the same tick, and only live reads", () => {
    const { registry: ops } = registry();
    expect(ops.runLive("count", {}, ctx)).toBe(3);
    expect(() => ops.runLive("greet", { name: "Ada" }, ctx)).toThrow("cannot be subscribed to");
  });

  it("passes who is asking to the handler", async () => {
    const whoami = read({ name: "whoami", output: out<string>() });
    const ops = new Registry([
      handle(whoami, (_input, { caller }) =>
        caller.relayed ? `device ${caller.deviceId}` : "this computer"
      ),
    ]);
    expect(await ops.run("whoami", "read", {}, ctx)).toBe("this computer");
    expect(
      await ops.run("whoami", "read", {}, { caller: { deviceId: "phone", relayed: true } })
    ).toBe("device phone");
  });

  it("refuses two handlers for one operation", () => {
    expect(() => new Registry([handle(count, () => 1), handle(count, () => 2)])).toThrow(
      "Two handlers answer count"
    );
  });
});
