import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { live, out, read, write } from "@shared/api/op";
import { boards, postBoardMessage } from "@shared/api/boards";
import { removeRepo } from "@shared/api/repos";
import type { AssistantAccess } from "@shared/types/assistants";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { assistantCaller } from "../../helpers";

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
      await ops.run(
        "whoami",
        "read",
        {},
        { caller: { deviceId: "phone", relayed: true, assistant: null } }
      )
    ).toBe("device phone");
  });

  it("refuses two handlers for one operation", () => {
    expect(() => new Registry([handle(count, () => 1), handle(count, () => 2)])).toThrow(
      "Two handlers answer count"
    );
  });
});

describe("an assistant's reach", () => {
  // A stand-in for the operator tools over MCP, registered under this name.
  const agentMcp = write({
    name: "agentMcp",
    input: z.object({ message: z.unknown() }),
    output: out<unknown>(),
  });
  const ops = new Registry([
    handle(greet, ({ name }) => `hello ${name}`),
    handle(rename, () => {}),
    handle(removeRepo, () => {}),
    handle(boards, () => []),
    handle(postBoardMessage, () => ({ seq: 1 })),
    handle(count, () => 3),
    handle(agentMcp, ({ message }) => ({ answered: message })),
  ]);
  const assistant = (access: AssistantAccess) => ({ caller: assistantCaller(access) });

  it.each(["pending", "read", "operate"] as const)(
    "refuses a %s assistant everything but the operator tools, reads, writes and live reads alike",
    async (access) => {
      expect(() => ops.runLive("boards", {}, assistant(access))).toThrow(/assistant/i);
      await expect(
        ops.run("postBoardMessage", "write", {}, assistant(access))
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        ops.run("greet", "read", { name: "Ada" }, assistant(access))
      ).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        ops.run("rename", "write", { to: "x" }, assistant(access))
      ).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(() => ops.runLive("count", {}, assistant(access))).toThrow(
        expect.objectContaining({ statusCode: 403 })
      );
      // What it may do there is the operator's to decide per tool, by its access.
      expect(await ops.run("agentMcp", "write", { message: { id: 1 } }, assistant(access))).toEqual(
        { answered: { id: 1 } }
      );
    }
  );

  it.each(["pending", "read", "operate"] as const)(
    "an assistant cannot remove a project with %s access",
    async (access) => {
      await expect(
        ops.run(
          removeRepo.name,
          "write",
          {
            repoId: "r",
            confirmed: {
              rootPath: null,
              counts: { archivedWorkspaces: 0, chats: 0, automations: 0 },
            },
          },
          assistant(access)
        )
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  );

  it("leaves this computer's window and paired devices as they were", async () => {
    expect(await ops.run("greet", "read", { name: "Ada" }, ctx)).toBe("hello Ada");
    const phone = { caller: { deviceId: "phone", relayed: true, assistant: null } };
    expect(await ops.run("greet", "read", { name: "Ada" }, phone)).toBe("hello Ada");
    // They may speak MCP to the operator tools too.
    expect(await ops.run("agentMcp", "write", { message: [] }, phone)).toEqual({ answered: [] });
  });
});
