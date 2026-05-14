import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleEditorMessage, type IpcMessage } from "../src/lib/ipc-host.ts";
import type { Context } from "../src/lib/types.ts";

const roots: string[] = [];

async function makeContext(): Promise<{ ctx: Context; outside: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "pencil-ipc-"));
  roots.push(root);
  const ctx = {
    workspace: join(root, "workspace"),
    storage: join(root, "storage"),
  };
  const outside = join(root, "outside");
  await fs.mkdir(ctx.workspace, { recursive: true });
  await fs.mkdir(ctx.storage, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { ctx, outside };
}

function request(method: string, payload: unknown): IpcMessage {
  return { id: `${method}-test`, type: "request", method, payload };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("handleEditorMessage filesystem IPC", () => {
  it("allows read and write inside workspace and storage roots", async () => {
    const { ctx } = await makeContext();
    const workspaceFile = join(ctx.workspace, "design.pen");
    const storageFile = join(ctx.storage, "scratch.bin");

    await expect(
      handleEditorMessage(request("write-file", { path: workspaceFile, contents: [65, 66] }), ctx)
    ).resolves.toMatchObject({ type: "response", error: undefined });

    await expect(
      handleEditorMessage(request("read-file", { path: workspaceFile }), ctx)
    ).resolves.toMatchObject({ payload: [65, 66] });

    await expect(
      handleEditorMessage(request("ensure-dir", { path: join(ctx.storage, "nested") }), ctx)
    ).resolves.toMatchObject({ type: "response", error: undefined });

    await expect(
      handleEditorMessage(request("write-file", { path: storageFile, contents: [67] }), ctx)
    ).resolves.toMatchObject({ type: "response", error: undefined });
  });

  it("rejects read, write, and mkdir outside workspace and storage roots", async () => {
    const { ctx, outside } = await makeContext();
    const outsideFile = join(outside, "secret.txt");
    const outsideDir = join(outside, "created");
    await fs.writeFile(outsideFile, "secret", "utf8");

    await expect(
      handleEditorMessage(request("read-file", { path: outsideFile }), ctx)
    ).resolves.toMatchObject({
      type: "response",
      error: { code: "HANDLER_ERROR", message: "path must be inside the workspace or AAP storage dir" },
    });

    await expect(
      handleEditorMessage(request("write-file", { path: outsideFile, contents: [88] }), ctx)
    ).resolves.toMatchObject({
      type: "response",
      error: { code: "HANDLER_ERROR", message: "path must be inside the workspace or AAP storage dir" },
    });

    await expect(
      handleEditorMessage(request("ensure-dir", { path: outsideDir }), ctx)
    ).resolves.toMatchObject({
      type: "response",
      error: { code: "HANDLER_ERROR", message: "path must be inside the workspace or AAP storage dir" },
    });

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("secret");
    expect(existsSync(outsideDir)).toBe(false);
  });

  it("rejects symlink escapes from allowed roots", async () => {
    const { ctx, outside } = await makeContext();
    const outsideFile = join(outside, "secret.txt");
    const workspaceLink = join(ctx.workspace, "outside-link");
    await fs.writeFile(outsideFile, "secret", "utf8");
    await fs.symlink(outside, workspaceLink, "dir");

    await expect(
      handleEditorMessage(request("read-file", { path: join(workspaceLink, "secret.txt") }), ctx)
    ).resolves.toMatchObject({
      type: "response",
      error: { code: "HANDLER_ERROR", message: "path must be inside the workspace or AAP storage dir" },
    });

    await expect(
      handleEditorMessage(
        request("write-file", { path: join(workspaceLink, "new-secret.txt"), contents: [88] }),
        ctx
      )
    ).resolves.toMatchObject({
      type: "response",
      error: { code: "HANDLER_ERROR", message: "path must be inside the workspace or AAP storage dir" },
    });

    expect(existsSync(join(outside, "new-secret.txt"))).toBe(false);
  });
});
