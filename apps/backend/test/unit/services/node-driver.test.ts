import { describe, it, expect, vi } from "vitest";
import * as git from "../../../src/services/git.service";
import { getCloudDiffSummary, hasLiveCloudSession } from "../../../src/services/agent/cloud/driver";
import { resolveNode } from "../../../src/services/node/driver";

vi.mock("../../../src/services/agent/cloud/driver", () => ({
  getCloudDiffSummary: vi.fn(async () => ({
    files: [{ type: "MODIFY", path: "x.ts", additions: 2, deletions: 5 }],
  })),
  getCloudDiffFile: vi.fn(async () => ({ diff: "@@ cloud diff @@" })),
  requestCloudFs: vi.fn(async () => ({ content: "cloud-bytes" })),
  hasLiveCloudSession: vi.fn(() => true),
}));

const local = {
  id: "ws1",
  kind: "worktree",
  git_target_branch: null,
  git_default_branch: "main",
  current_session_id: null,
  init_stage: null,
} as const;
const cloud = { ...local, id: "ws2", kind: "cloud", current_session_id: "sess_1" } as const;

describe("NodeDriver", () => {
  it("passes unexpected read errors to the reporter unchanged", async () => {
    const error = new TypeError("invalid projection");
    vi.spyOn(git, "resolveParentBranch").mockResolvedValue("main");
    vi.spyOn(git, "getDiffFiles").mockRejectedValue(error);
    await expect(resolveNode(local, "/tmp/ws1").diffFiles()).rejects.toBe(error);
  });

  it.each(["../ws1-backup/file.ts", ".", "/tmp/ws1/file.ts"])(
    "asks for a workspace-relative file when the diff read receives %s",
    async (file) => {
      await expect(resolveNode(local, "/tmp/ws1").diffFile(file)).rejects.toThrow(
        /file path relative to the workspace/i
      );
    }
  );

  it.each([
    ["CREATE", "added"],
    ["MODIFY", "modified"],
    ["DELETE", "deleted"],
    ["RENAME", "renamed"],
    ["unknown", "modified"],
  ])("maps cloud status %s on the changed-files list", async (type, status) => {
    const entry = { type, path: "x.ts", oldPath: "old.ts", additions: 2, deletions: 5 };
    const change = { file: "x.ts", status, ...(type === "RENAME" && { previous_path: "old.ts" }) };
    vi.mocked(getCloudDiffSummary).mockResolvedValue({ files: [entry] });
    const driver = resolveNode(cloud, "");
    expect(await driver.diffStats()).toEqual({ additions: 2, deletions: 5 });
    expect(await driver.diffFiles()).toEqual({
      files: [{ ...change, additions: 2, deletions: 5 }],
    });
  });

  it("returns an empty diff while a cloud workspace has no session", async () => {
    const driver = resolveNode({ ...cloud, current_session_id: null }, "");
    expect(await driver.diffStats()).toEqual({ additions: 0, deletions: 0 });
    expect(await driver.diffFiles()).toEqual({ files: [] });
    expect(await driver.diffFile("x.ts")).toEqual({
      ok: true,
      file: "x.ts",
      diff: "",
      old_content: null,
      new_content: null,
    });
  });

  it("row numbers never connect to a computer with no open channel or one asleep", async () => {
    vi.mocked(getCloudDiffSummary).mockClear();
    vi.mocked(hasLiveCloudSession).mockReturnValueOnce(false);
    expect(await resolveNode(cloud, "").diffStats()).toEqual({ additions: 0, deletions: 0 });
    for (const init_stage of ["paused", "stopped", "resuming", "error"]) {
      expect(await resolveNode({ ...cloud, init_stage }, "").diffStats()).toEqual({
        additions: 0,
        deletions: 0,
      });
    }
    expect(getCloudDiffSummary).not.toHaveBeenCalled();
    await resolveNode(cloud, "").diffFiles();
    expect(getCloudDiffSummary).toHaveBeenCalledOnce();
  });
});
