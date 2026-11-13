import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/terminal";
import { operations } from "../../helpers";

// The terminal operations: what a client's frame becomes for ptyRouter. Where a
// terminal runs (node-pty or a cloud sandbox) is node-pty.test.ts.

const ptyRouter = vi.hoisted(() => ({
  open: vi.fn(async (params: { id: string }) => params.id),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("../../../src/services/node/pty", () => ({ ptyRouter }));

import terminalHandlers from "../../../src/api/terminal";

const run = operations(terminalHandlers);

beforeEach(() => vi.clearAllMocks());

describe("ptySpawn", () => {
  it("opens the terminal the client described and answers with its id", async () => {
    const options = {
      id: "t1",
      command: "/bin/zsh",
      args: ["-l"],
      cols: 120,
      rows: 40,
      cwd: "/repos/myrepo/.deus/tokyo",
    };

    expect(await run(api.ptySpawn, options)).toEqual({ id: "t1" });
    expect(ptyRouter.open).toHaveBeenCalledExactlyOnceWith(options);
  });

  it("defaults to bash at 80×24 when only an id is given", async () => {
    await run(api.ptySpawn, { id: "t1" });

    expect(ptyRouter.open).toHaveBeenCalledExactlyOnceWith({
      id: "t1",
      command: "bash",
      args: [],
      cols: 80,
      rows: 24,
    });
  });

  it("names the cloud workspace whose sandbox runs the shell", async () => {
    await run(api.ptySpawn, { id: "t1", cwd: "/project", cloudWorkspaceId: "ws-cloud" });

    expect(ptyRouter.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "t1", cwd: "/project", cloudWorkspaceId: "ws-cloud" })
    );
  });

  it("tells the client why a terminal could not start", async () => {
    ptyRouter.open.mockRejectedValueOnce(
      new Error("Cloud workspace has no active session for a terminal")
    );

    await expect(run(api.ptySpawn, { id: "t1", cloudWorkspaceId: "ws-cloud" })).rejects.toThrow(
      "Cloud workspace has no active session for a terminal"
    );
  });

  it("is refused without an id", async () => {
    await expect(run(api.ptySpawn, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "ptySpawn requires id",
    });
    expect(ptyRouter.open).not.toHaveBeenCalled();
  });
});

describe("ptyWrite", () => {
  it("passes the bytes through as numbers", async () => {
    expect(await run(api.ptyWrite, { id: "t1", data: [108, 115, 13] })).toBeUndefined();
    expect(ptyRouter.write).toHaveBeenCalledExactlyOnceWith("t1", [108, 115, 13]);
  });

  it("is refused without data", async () => {
    await expect(run(api.ptyWrite, { id: "t1" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "ptyWrite requires data",
    });
    await expect(run(api.ptyWrite, { id: "t1", data: "ls\r" } as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ptyRouter.write).not.toHaveBeenCalled();
  });

  it("tells the client when the terminal is gone", async () => {
    ptyRouter.write.mockImplementationOnce(() => {
      throw new Error("PTY instance not found: t1");
    });

    await expect(run(api.ptyWrite, { id: "t1", data: [13] })).rejects.toThrow(
      "PTY instance not found: t1"
    );
  });
});

describe("ptyResize", () => {
  it("resizes the terminal", async () => {
    expect(await run(api.ptyResize, { id: "t1", cols: 100, rows: 30 })).toBeUndefined();
    expect(ptyRouter.resize).toHaveBeenCalledExactlyOnceWith("t1", 100, 30);
  });

  it("is refused without a whole, positive size", async () => {
    await expect(run(api.ptyResize, { id: "t1", cols: 100 } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "ptyResize requires rows",
    });
    await expect(run(api.ptyResize, { id: "t1", cols: 0, rows: 30 })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ptyRouter.resize).not.toHaveBeenCalled();
  });
});

describe("ptyKill", () => {
  it("closes the terminal", async () => {
    expect(await run(api.ptyKill, { id: "t1" })).toBeUndefined();
    expect(ptyRouter.kill).toHaveBeenCalledExactlyOnceWith("t1");
  });
});
