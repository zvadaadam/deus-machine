import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/files";
import { operations } from "../../helpers";

// The file operations for a cloud workspace: handler → resolveNode →
// RemoteNodeDriver, with the sandbox's fs channel mocked. The local lane is
// files.test.ts.

const { mockRequestCloudFs, cloudWorkspace, identityState } = vi.hoisted(() => {
  const cloudWorkspace: Record<string, unknown> = {
    id: "ws-cloud-1",
    kind: "cloud",
    current_session_id: "sess-cloud-1",
  };
  return { cloudWorkspace, identityState: { gen: 0 }, mockRequestCloudFs: vi.fn() };
});

vi.mock("../../../src/services/agent/cloud/driver", () => ({
  requestCloudFs: mockRequestCloudFs,
  getCloudIdentityGeneration: () => identityState.gen,
}));

vi.mock("../../../src/middleware/workspace-loader", () => ({
  loadWorkspace: () => ({ workspace: cloudWorkspace, workspacePath: "" }),
}));

vi.mock("../../../src/services/fs-watcher.service", () => ({
  watchWorkspace: vi.fn(),
  unwatchWorkspace: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../src/db", () => ({ getWorkspaceForMiddleware: vi.fn() }));

import fileHandlers from "../../../src/api/files";

const run = operations(fileHandlers);
const workspace = { workspaceId: "ws-cloud-1" };
const search = (query: string) => run(api.fileSearch, { ...workspace, query });

beforeEach(() => {
  vi.clearAllMocks();
  cloudWorkspace.current_session_id = "sess-cloud-1";
  identityState.gen = 0;
});

describe("cloud file operations", () => {
  it("tree returns an empty listing (not an error panel) while provisioning", async () => {
    cloudWorkspace.current_session_id = null;

    const tree = await run(api.workspaceFiles, workspace);

    expect(tree.files).toEqual([]);
    expect(tree.provisioning).toBe(true);
    expect(mockRequestCloudFs).not.toHaveBeenCalled();
  });

  it("invalidateFileCache clears the cloud tree cache so mentions don't go stale", async () => {
    cloudWorkspace.current_session_id = "sess-invalidate";
    mockRequestCloudFs.mockResolvedValue({ tree: [{ name: "a.ts", path: "a.ts", type: "file" }] });
    // warm the search cache
    await search("a");
    await run(api.invalidateFileCache, workspace);
    mockRequestCloudFs.mockClear();
    // a fresh search must re-list (cache was cleared), not serve the stale set
    await search("a");
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
  });

  it("tree maps FsNode → local shape and carries the truncation flag", async () => {
    mockRequestCloudFs.mockResolvedValue({
      tree: [
        {
          name: "src",
          path: "src",
          type: "dir",
          children: [{ name: "a.ts", path: "src/a.ts", type: "file", size: 5 }],
        },
      ],
      truncated: true,
    });

    const tree = await run(api.workspaceFiles, workspace);

    expect(tree.files[0]).toEqual({
      name: "src",
      path: "src",
      type: "directory",
      children: [{ name: "a.ts", path: "src/a.ts", type: "file", size: 5 }],
    });
    expect(tree.totalFiles).toBe(1);
    expect(tree.totalSize).toBe(5);
    expect(tree.truncated).toBe(true);
  });

  it("read answers with the sandbox file's text", async () => {
    mockRequestCloudFs.mockResolvedValue({ content: "# Readme\n" });

    expect(await run(api.fileContent, { ...workspace, path: "README.md" })).toEqual({
      content: "# Readme\n",
    });
    expect(mockRequestCloudFs).toHaveBeenCalledWith("sess-cloud-1", {
      op: "read",
      path: "README.md",
    });
  });

  it("read refuses traversal before any sandbox round-trip", async () => {
    await expect(
      run(api.fileContent, { ...workspace, path: "../../etc/passwd" })
    ).rejects.toMatchObject({ statusCode: 400, message: "Invalid file path" });
    expect(mockRequestCloudFs).not.toHaveBeenCalled();
  });

  it("read refuses a file the sandbox has no text for as binary_file (422)", async () => {
    mockRequestCloudFs.mockResolvedValue({});

    await expect(run(api.fileContent, { ...workspace, path: "logo.png" })).rejects.toMatchObject({
      statusCode: 422,
      message: "binary_file",
    });
  });

  it("a sandbox timeout surfaces as an instruction, not a 500", async () => {
    mockRequestCloudFs.mockRejectedValue(new Error("cloud fs request timed out"));

    await expect(run(api.fileContent, { ...workspace, path: "README.md" })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/waking|shortly/i),
    });
  });

  it("search caches the flattened tree across keystrokes", async () => {
    cloudWorkspace.current_session_id = "sess-search-cache";
    mockRequestCloudFs.mockResolvedValue({
      tree: [{ name: "alpha.ts", path: "alpha.ts", type: "file" }],
    });

    await search("al");
    const second = await search("alp");

    expect(second[0]?.path).toBe("alpha.ts");
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent searches during the first list into one round-trip", async () => {
    cloudWorkspace.current_session_id = "sess-single-flight";
    let resolveList!: (v: unknown) => void;
    const listPromise = new Promise((res) => {
      resolveList = res;
    });
    mockRequestCloudFs.mockReturnValue(listPromise);

    // three keystrokes land while the first (slow) list is still in flight
    const all = Promise.all([search("a"), search("ab"), search("abc")]);
    await new Promise((r) => setTimeout(r, 0)); // let all three reach the shared await
    resolveList({ tree: [{ name: "alpha.ts", path: "alpha.ts", type: "file" }] });
    await all;

    // one shared sandbox list, not one per keystroke
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
    mockRequestCloudFs.mockReset();
  });

  it("re-lists after a cloud identity change instead of serving another account's cache", async () => {
    cloudWorkspace.current_session_id = "sess-identity";
    mockRequestCloudFs.mockResolvedValue({ tree: [{ name: "a.ts", path: "a.ts", type: "file" }] });
    // account A warms the cache
    await run(api.workspaceFiles, workspace);
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
    // sign-out / switch bumps the identity generation
    identityState.gen = 1;
    // a request for the still-persisted session must NOT serve A's cached tree —
    // the generation mismatch forces a fresh (re-authenticating) list
    await run(api.workspaceFiles, workspace);
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(2);
  });
});
