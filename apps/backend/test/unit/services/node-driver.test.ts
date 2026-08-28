import { describe, it, expect, vi } from "vitest";

// Local lane → git.service; Remote lane → the cloud session socket. Mock both so
// the test exercises the driver's extraction/mapping, not the real transports.
vi.mock("../../../src/services/git.service", () => ({
  resolveParentBranch: vi.fn(() => "main"),
  getDiffStats: vi.fn(() => ({ additions: 3, deletions: 1 })),
  getDiffFiles: vi.fn(() => [{ file: "a.ts", additions: 3, deletions: 1 }]),
  resolveWorkspaceRelativePath: vi.fn((_ws: string, f: string) => f),
  getFileDiff: vi.fn(() => "@@ local diff @@"),
  extractDiffInfo: vi.fn(() => ({ isNew: false, isDeleted: false, oldPath: "", newPath: "" })),
  getMergeBase: vi.fn(() => "base-sha"),
  getGitFileContent: vi.fn(() => "old-bytes"),
}));

vi.mock("../../../src/services/agent/cloud/driver", () => ({
  getCloudDiffSummary: vi.fn(async () => ({
    files: [{ type: "M", path: "x.ts", additions: 2, deletions: 5 }],
  })),
  getCloudDiffFile: vi.fn(async () => ({ path: "x.ts", diff: "@@ cloud diff @@" })),
  requestCloudFs: vi.fn(async () => ({ content: "cloud-bytes" })),
}));

import { resolveNode } from "../../../src/services/node/driver";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asWs = (o: Record<string, unknown>) => o as any;
const local = asWs({
  id: "ws1",
  kind: "worktree",
  git_target_branch: null,
  git_default_branch: "main",
});
const cloud = asWs({ id: "ws2", kind: "cloud", current_session_id: "sess_1" });
const cloudAsleep = asWs({ id: "ws3", kind: "cloud", current_session_id: null });

describe("NodeDriver — diff dispatch", () => {
  it("local workspace → git lane", async () => {
    const d = resolveNode(local, "/tmp/ws1");
    expect(await d.diffStats()).toEqual({ additions: 3, deletions: 1 });
    expect(await d.diffFiles()).toEqual({ files: [{ file: "a.ts", additions: 3, deletions: 1 }] });
    const outcome = await d.diffFile("a.ts");
    expect(outcome).toMatchObject({ ok: true, file: "a.ts", diff: "@@ local diff @@" });
  });

  it("cloud workspace → session socket, summary mapped to the route shape", async () => {
    const d = resolveNode(cloud, "");
    // stats reduce over the summary; files map path→file
    expect(await d.diffStats()).toEqual({ additions: 2, deletions: 5 });
    expect(await d.diffFiles()).toEqual({ files: [{ file: "x.ts", additions: 2, deletions: 5 }] });
    const outcome = await d.diffFile("x.ts");
    expect(outcome).toEqual({
      ok: true,
      file: "x.ts",
      diff: "@@ cloud diff @@",
      old_content: null,
      new_content: "cloud-bytes",
    });
  });

  it("asleep cloud sandbox (no session) → empty shapes, never an error", async () => {
    const d = resolveNode(cloudAsleep, "");
    expect(await d.diffStats()).toEqual({ additions: 0, deletions: 0 });
    expect(await d.diffFiles()).toEqual({ files: [] });
    expect(await d.diffFile("x.ts")).toEqual({
      ok: true,
      file: "x.ts",
      diff: "",
      old_content: null,
      new_content: null,
    });
  });

  it("local invalid path → ValidationError (unchanged from the route)", async () => {
    const { resolveWorkspaceRelativePath } = await import("../../../src/services/git.service");
    (resolveWorkspaceRelativePath as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    await expect(resolveNode(local, "/tmp/ws1").diffFile("../escape")).rejects.toThrow(
      "Invalid file path"
    );
  });
});
