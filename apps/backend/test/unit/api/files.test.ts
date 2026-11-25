import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/files";
import { operations } from "../../helpers";

// The file operations for a local workspace: handler → resolveNode →
// LocalNodeDriver, with the scanner and the disk mocked. The cloud lane is
// cloud-files.test.ts.

const files = vi.hoisted(() => ({
  scanWorkspaceFiles: vi.fn(),
  readTextFile: vi.fn(),
  listTopFiles: vi.fn(),
  fuzzySearchFiles: vi.fn(),
}));
vi.mock("../../../src/services/files.service", () => files);
const relay = vi.hoisted(() => ({ serverId: "0123456789abcdef", relayUrl: "wss://relay.test" }));
vi.mock("../../../src/services/relay.service", () => ({
  getRelayStatus: () => relay,
}));

vi.mock("../../../src/middleware/workspace-loader", () => ({
  loadWorkspace: () => ({
    workspace: { id: "ws-123", root_path: "/repos/myrepo", slug: "test-ws" },
    workspacePath: "/repos/myrepo/.deus/test-ws",
  }),
}));

// A local workspace never reaches the sandbox.
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  requestCloudFs: vi.fn(),
  getCloudIdentityGeneration: () => 0,
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../src/db", () => ({ getWorkspaceForMiddleware: vi.fn() }));

const { mockExistsSync, mockRealpathSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockRealpathSync: vi.fn((p: string) => p),
}));
vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: mockExistsSync,
      realpathSync: mockRealpathSync,
      statSync: () => ({ isFile: () => true, size: 7, dev: 1, ino: 2 }),
    },
    existsSync: mockExistsSync,
    realpathSync: mockRealpathSync,
  };
});

import fileHandlers from "../../../src/api/files";

const run = operations(fileHandlers);
const workspace = { workspaceId: "ws-123" };
const WORKSPACE_PATH = "/repos/myrepo/.deus/test-ws";

beforeEach(() => {
  relay.relayUrl = "wss://relay.test";
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockRealpathSync.mockImplementation((p: string) => p);
});

describe("workspaceFiles", () => {
  it("answers with the scanned tree", async () => {
    const tree = {
      files: [
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [{ name: "app.ts", path: "src/app.ts", type: "file", size: 1024 }],
        },
        { name: "README.md", path: "README.md", type: "file", size: 512 },
      ],
      totalFiles: 2,
      totalSize: 1536,
    };
    files.scanWorkspaceFiles.mockReturnValue(tree);

    expect(await run(api.workspaceFiles, workspace)).toEqual(tree);
    expect(files.scanWorkspaceFiles).toHaveBeenCalledWith(WORKSPACE_PATH);
  });

  it("is refused without a workspace", async () => {
    await expect(run(api.workspaceFiles, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "workspaceFiles requires workspaceId",
    });
  });
});

describe("fileContent", () => {
  it("answers with the file's text", async () => {
    files.readTextFile.mockReturnValue("const x = 1;\n");

    expect(await run(api.fileContent, { ...workspace, path: "src/app.ts" })).toEqual({
      content: "const x = 1;\n",
    });
    expect(files.readTextFile).toHaveBeenCalledWith(`${WORKSPACE_PATH}/src/app.ts`);
  });

  it("is refused without a path", async () => {
    await expect(run(api.fileContent, workspace as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "fileContent requires path",
    });
  });

  it("rejects directory traversal attempts", async () => {
    await expect(
      run(api.fileContent, { ...workspace, path: "../../etc/passwd" })
    ).rejects.toMatchObject({ statusCode: 400, message: "Invalid file path" });
    expect(files.readTextFile).not.toHaveBeenCalled();
  });

  it("rejects absolute paths", async () => {
    await expect(run(api.fileContent, { ...workspace, path: "/etc/passwd" })).rejects.toMatchObject(
      { statusCode: 400, message: "Invalid file path" }
    );
    expect(files.readTextFile).not.toHaveBeenCalled();
  });

  it("rejects symlink escapes outside the workspace", async () => {
    mockRealpathSync.mockImplementation((p: string) =>
      p === `${WORKSPACE_PATH}/src/link.txt` ? "/etc/passwd" : p
    );

    await expect(
      run(api.fileContent, { ...workspace, path: "src/link.txt" })
    ).rejects.toMatchObject({ statusCode: 400, message: "Invalid file path" });
    expect(files.readTextFile).not.toHaveBeenCalled();
  });

  it("reports a missing file", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(run(api.fileContent, { ...workspace, path: "gone.ts" })).rejects.toMatchObject({
      statusCode: 400,
      message: "File not found",
    });
  });

  it("refuses a binary file as binary_file (422)", async () => {
    files.readTextFile.mockReturnValue(null);

    await expect(run(api.fileContent, { ...workspace, path: "image.png" })).rejects.toMatchObject({
      statusCode: 422,
      message: "binary_file",
    });
  });
});

describe("fileSearch", () => {
  const hits = [{ path: "src/app.ts", name: "app.ts", score: 12 }];

  it("lists the files nearest the root when there is no query", async () => {
    files.listTopFiles.mockReturnValue(hits);

    expect(await run(api.fileSearch, workspace)).toEqual(hits);
    expect(await run(api.fileSearch, { ...workspace, query: "" })).toEqual(hits);
    expect(files.listTopFiles).toHaveBeenNthCalledWith(1, WORKSPACE_PATH, 15);
    expect(files.listTopFiles).toHaveBeenNthCalledWith(2, WORKSPACE_PATH, 15);
    expect(files.fuzzySearchFiles).not.toHaveBeenCalled();
  });

  it("searches by the query, 15 results unless a limit is given", async () => {
    files.fuzzySearchFiles.mockReturnValue(hits);

    expect(await run(api.fileSearch, { ...workspace, query: "app" })).toEqual(hits);
    await run(api.fileSearch, { ...workspace, query: "app", limit: 3 });
    expect(files.fuzzySearchFiles).toHaveBeenNthCalledWith(1, WORKSPACE_PATH, "app", 15);
    expect(files.fuzzySearchFiles).toHaveBeenNthCalledWith(2, WORKSPACE_PATH, "app", 3);
  });

  it("refuses a limit that is not a positive whole number", async () => {
    await expect(run(api.fileSearch, { ...workspace, limit: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(files.listTopFiles).not.toHaveBeenCalled();
  });
});

describe("fileUrl", () => {
  it.each([
    ["ws://staging-relay.test:8787", "http://staging-relay.test:8787"],
    ["https://relay.test", "https://relay.test"],
    ["http://relay.test", "http://relay.test"],
  ])("uses the file origin configured by %s", async (override, origin) => {
    relay.relayUrl = override;
    const relayed = operations(fileHandlers, { relayed: true, deviceId: "phone", assistant: null });
    const { url } = await relayed(api.fileUrl, { kind: "preview", ...workspace, path: "a.png" });
    expect(new URL(url).origin).toBe(origin);
  });

  it("gives direct callers the existing recording and workspace paths", async () => {
    const { url } = await run(api.fileUrl, { kind: "recording", path: "/tmp/one #.mp4" });
    expect(url).toBe("/api/files/stream?path=%2Ftmp%2Fone%20%23.mp4");
    expect(
      await run(api.fileUrl, { kind: "preview", workspaceId: "w/1", path: "one #.html" })
    ).toEqual({ url: "/api/workspaces/w%2F1/file-preview?path=one%20%23.html" });
  });

  it("issues an opaque reusable URL to a relayed device and refuses HTML previews", async () => {
    const relayed = operations(fileHandlers, { relayed: true, deviceId: "phone", assistant: null });
    const input = { kind: "preview" as const, workspaceId: "ws-123", path: "assets/file.png" };
    const { url } = await relayed(api.fileUrl, input);
    expect(url).toMatch(
      /^https:\/\/relay\.test\/api\/servers\/0123456789abcdef\/files\/[\w-]{22}\/[\w-]{22}$/
    );
    expect(await relayed(api.fileUrl, input)).toEqual({ url });
    const other = operations(fileHandlers, { relayed: true, deviceId: "tablet", assistant: null });
    expect((await other(api.fileUrl, input)).url).not.toBe(url);
    for (const path of ["site.html", "site.htm"])
      await expect(relayed(api.fileUrl, { ...input, path })).rejects.toThrow(/HTML previews/);
  });
});
