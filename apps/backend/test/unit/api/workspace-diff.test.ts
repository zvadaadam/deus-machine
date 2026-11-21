import { vi, describe, it, expect } from "vitest";
import * as api from "@shared/api/workspaces";
import { operations } from "../../helpers";

// The diff operations through the real handler → resolveNode →
// Local/RemoteNodeDriver, asserting what a client receives on both lanes.
// Mirrors files.test.ts / cloud-files.test.ts.

const { workspaceRef } = vi.hoisted(() => {
  const workspaceRef: { current: Record<string, unknown> } = {
    current: {
      id: "ws-local",
      kind: "worktree",
      git_target_branch: null,
      git_default_branch: "main",
    },
  };
  return { workspaceRef };
});
vi.mock("../../../src/middleware/workspace-loader", () => ({
  loadWorkspace: () => ({
    workspace: workspaceRef.current,
    workspacePath: workspaceRef.current.kind === "cloud" ? "" : "/tmp/ws-local",
  }),
}));

const git = vi.hoisted(() => ({
  getDiffStats: vi.fn(async () => ({ additions: 3, deletions: 1 })),
  getDiffFiles: vi.fn(async () => [{ file: "a.ts", additions: 3, deletions: 1 }]),
  resolveParentBranch: vi.fn(async () => "main"),
  resolveWorkspaceRelativePath: vi.fn((_p: string, f: string) => f),
  getFileDiff: vi.fn(async () => "@@ local diff @@"),
  extractDiffInfo: vi.fn(() => ({ isNew: true, isDeleted: false, oldPath: "", newPath: "" })),
  getMergeBase: vi.fn(async () => "base"),
  getGitFileContent: vi.fn(async () => ""),
}));
vi.mock("../../../src/services/git.service", () => git);

const cloud = vi.hoisted(() => ({
  getCloudDiffSummary: vi.fn(async () => ({
    files: [{ type: "M", path: "x.ts", additions: 2, deletions: 5 }],
  })),
  getCloudDiffFile: vi.fn(async () => ({ path: "x.ts", diff: "@@ cloud diff @@" })),
  requestCloudFs: vi.fn(async () => ({ content: "cloud-bytes" })),
  getCloudIdentityGeneration: vi.fn(() => 0),
  // The row numbers ask only a computer with an open channel (node/driver.ts).
  hasLiveCloudSession: vi.fn(() => true),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => cloud);

import workspaceHandlers from "../../../src/api/workspaces";

const run = operations(workspaceHandlers);
const local = { workspaceId: "ws-local" };
const inCloud = { workspaceId: "ws-cloud" };

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

describe("diff operations (through NodeDriver)", () => {
  it("local diffStats → git lane", async () => {
    setLocal();
    expect(await run(api.diffStats, local)).toEqual({ additions: 3, deletions: 1 });
  });

  it("local diffFiles → git lane", async () => {
    setLocal();
    expect(await run(api.diffFiles, local)).toEqual({
      files: [{ file: "a.ts", additions: 3, deletions: 1 }],
    });
  });

  it("local diffFile → the four fields", async () => {
    setLocal();
    expect(await run(api.diffFile, { ...local, file: "a.ts" })).toMatchObject({
      file: "a.ts",
      diff: "@@ local diff @@",
    });
  });

  it("reports a failed local comparison to every diff operation without exposing git's paths", async () => {
    setLocal();
    git.resolveParentBranch.mockRejectedValue(
      Object.assign(new Error("git in a private folder"), { killed: true })
    );
    try {
      for (const result of [
        () => run(api.diffStats, local),
        () => run(api.diffFiles, local),
        () => run(api.diffFile, { ...local, file: "a.ts" }),
      ]) {
        await expect(result()).rejects.toThrow("Could not read the changes: git timed out.");
      }
    } finally {
      git.resolveParentBranch.mockResolvedValue("main");
    }
  });

  it("diffFile without a file is refused", async () => {
    setLocal();
    await expect(run(api.diffFile, local as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "diffFile requires file",
    });
  });

  it("cloud diffStats reduces the summary", async () => {
    setCloud();
    expect(await run(api.diffStats, inCloud)).toEqual({ additions: 2, deletions: 5 });
  });

  it("cloud diffFiles maps path→file", async () => {
    setCloud();
    expect(await run(api.diffFiles, inCloud)).toEqual({
      files: [{ file: "x.ts", additions: 2, deletions: 5 }],
    });
  });

  it("cloud diffFile returns diff + fs content", async () => {
    setCloud();
    expect(await run(api.diffFile, { ...inCloud, file: "x.ts" })).toEqual({
      file: "x.ts",
      diff: "@@ cloud diff @@",
      old_content: null,
      new_content: "cloud-bytes",
    });
  });

  it("cloud diffFile: a rejecting content read does NOT sink an available diff", async () => {
    setCloud();
    cloud.requestCloudFs.mockRejectedValueOnce(new Error("fs channel down"));
    expect(await run(api.diffFile, { ...inCloud, file: "x.ts" })).toEqual({
      file: "x.ts",
      diff: "@@ cloud diff @@",
      old_content: null,
      new_content: null,
    });
  });

  it("cloud diffFile: an unavailable diff is refused with the cloud's reason", async () => {
    setCloud();
    cloud.getCloudDiffFile.mockRejectedValueOnce(new Error("socket closed"));
    await expect(run(api.diffFile, { ...inCloud, file: "x.ts" })).rejects.toMatchObject({
      statusCode: 502,
      message: "diff_failed",
    });
  });

  it("propagates an attempted cloud summary's failure to both reads", async () => {
    setCloud();
    cloud.getCloudDiffSummary.mockRejectedValueOnce(new Error("channel closed"));
    await expect(run(api.diffFiles, inCloud)).rejects.toThrow("channel closed");
    cloud.getCloudDiffSummary.mockResolvedValueOnce({
      files: [],
      error: "comparison unavailable",
    } as Awaited<ReturnType<typeof cloud.getCloudDiffSummary>>);
    await expect(run(api.diffStats, inCloud)).rejects.toThrow("comparison unavailable");
  });

  it("asleep cloud (no session) → empty diff, not an error", async () => {
    setCloud(null);
    expect(await run(api.diffStats, inCloud)).toEqual({ additions: 0, deletions: 0 });
    expect(await run(api.diffFiles, inCloud)).toEqual({ files: [] });
  });
});
