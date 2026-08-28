import { vi, describe, it, expect } from "vitest";
import { Hono } from "hono";

// Route-level coverage for the diff routes AFTER the NodeDriver refactor: drives
// the real route → resolveNode → Local/RemoteNodeDriver, asserting the HTTP
// status + body contract for both lanes. Mirrors files.test.ts / cloud-files.test.ts.

const { workspaceRef, mockWithWorkspace } = vi.hoisted(() => {
  const workspaceRef: { current: Record<string, unknown> } = {
    current: {
      id: "ws-local",
      kind: "worktree",
      git_target_branch: null,
      git_default_branch: "main",
    },
  };
  return {
    workspaceRef,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWithWorkspace: vi.fn((c: any, next: any) => {
      c.set("workspace", workspaceRef.current);
      c.set("workspacePath", workspaceRef.current.kind === "cloud" ? "" : "/tmp/ws-local");
      return next();
    }),
  };
});
vi.mock("../../../src/middleware/workspace-loader", () => ({ withWorkspace: mockWithWorkspace }));

const git = vi.hoisted(() => ({
  getDiffStats: vi.fn(() => ({ additions: 3, deletions: 1 })),
  getDiffFiles: vi.fn(() => [{ file: "a.ts", additions: 3, deletions: 1 }]),
  resolveParentBranch: vi.fn(() => "main"),
  resolveWorkspaceRelativePath: vi.fn((_p: string, f: string) => f),
  getFileDiff: vi.fn(() => "@@ local diff @@"),
  extractDiffInfo: vi.fn(() => ({ isNew: true, isDeleted: false, oldPath: "", newPath: "" })),
  getMergeBase: vi.fn(() => "base"),
  getGitFileContent: vi.fn(() => ""),
}));
vi.mock("../../../src/services/git.service", () => git);

const cloud = vi.hoisted(() => ({
  getCloudDiffSummary: vi.fn(async () => ({
    files: [{ type: "M", path: "x.ts", additions: 2, deletions: 5 }],
  })),
  getCloudDiffFile: vi.fn(async () => ({ path: "x.ts", diff: "@@ cloud diff @@" })),
  requestCloudFs: vi.fn(async () => ({ content: "cloud-bytes" })),
  getCloudIdentityGeneration: vi.fn(() => 0),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => cloud);

import diffRoutes from "../../../src/routes/workspaces.diff";
import { errorHandler } from "../../../src/middleware/error-handler";

const app = new Hono();
app.route("/", diffRoutes);
app.onError(errorHandler);

const setLocal = () => {
  workspaceRef.current = {
    id: "ws-local",
    kind: "worktree",
    git_target_branch: null,
    git_default_branch: "main",
  };
};
const setCloud = (sessionId: string | null = "sess-1") => {
  workspaceRef.current = { id: "ws-cloud", kind: "cloud", current_session_id: sessionId };
};

describe("diff routes (through NodeDriver)", () => {
  it("local diff-stats → git lane", async () => {
    setLocal();
    const res = await app.request("/workspaces/ws-local/diff-stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ additions: 3, deletions: 1 });
  });

  it("local diff-files → git lane", async () => {
    setLocal();
    const res = await app.request("/workspaces/ws-local/diff-files");
    expect(await res.json()).toEqual({ files: [{ file: "a.ts", additions: 3, deletions: 1 }] });
  });

  it("local diff-file → the four fields", async () => {
    setLocal();
    const res = await app.request("/workspaces/ws-local/diff-file?file=a.ts");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ file: "a.ts", diff: "@@ local diff @@" });
  });

  it("diff-file without ?file → 400", async () => {
    setLocal();
    const res = await app.request("/workspaces/ws-local/diff-file");
    expect(res.status).toBe(400);
  });

  it("cloud diff-stats reduces the summary", async () => {
    setCloud();
    const res = await app.request("/workspaces/ws-cloud/diff-stats");
    expect(await res.json()).toEqual({ additions: 2, deletions: 5 });
  });

  it("cloud diff-files maps path→file", async () => {
    setCloud();
    const res = await app.request("/workspaces/ws-cloud/diff-files");
    expect(await res.json()).toEqual({ files: [{ file: "x.ts", additions: 2, deletions: 5 }] });
  });

  it("cloud diff-file returns diff + fs content", async () => {
    setCloud();
    const res = await app.request("/workspaces/ws-cloud/diff-file?file=x.ts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      file: "x.ts",
      diff: "@@ cloud diff @@",
      old_content: null,
      new_content: "cloud-bytes",
    });
  });

  it("asleep cloud (no session) → empty diff, 200 not error", async () => {
    setCloud(null);
    expect(await (await app.request("/workspaces/ws-cloud/diff-stats")).json()).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(await (await app.request("/workspaces/ws-cloud/diff-files")).json()).toEqual({
      files: [],
    });
  });
});
