import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { resolveNode } from "../../../src/services/node/driver";

// End-to-end symlink-escape regression for LocalNodeDriver.diffFile, using real
// git, real fs, and the real LocalNodeDriver — no mocks on git.service or fs.
// The diff lane reads the working tree with `fs.readFileSync` (which follows
// symlinks): a worktree-relative symlink whose target lies OUTSIDE the worktree
// must be rejected with a ValidationError rather than leaking the target's bytes
// into `new_content` (the fs-read lane's realpath containment re-check, now shared
// via resolveContainedRealPath).

describe("diffFile symlink escape — LocalNodeDriver lane", () => {
  let tmpDir: string;
  let workspacePath: string;
  let secretPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let driver: any;
  const ws = {
    id: "ws-123",
    kind: "worktree",
    git_target_branch: null,
    git_default_branch: "main",
  } as const;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    secretPath = path.join(tmpDir, "SECRET.txt");
    fs.writeFileSync(secretPath, "TOP-SECRET-CONTENT-SHOULD-NOT-LEAK");

    // Origin repo with one commit, then a worktree off it — same shape as
    // workspace-init.service.ts (`git worktree add -b <branch> <ws> <base>`).
    const origin = path.join(tmpDir, "origin");
    execSync(`git init -q -b main ${origin}`);
    execSync(`git -C ${origin} config user.email t@t.t && git -C ${origin} config user.name t`);
    fs.writeFileSync(path.join(origin, "README.md"), "hello\n");
    execSync(`git -C ${origin} add . && git -C ${origin} commit -qm init`);

    workspacePath = path.join(tmpDir, "ws");
    execSync(`git -C ${origin} worktree add -b ws-branch ${workspacePath} main`);

    driver = resolveNode(ws as never, workspacePath);
  });

  afterEach(() => {
    try {
      execSync(`git -C ${workspacePath} worktree unlock --force 2>/dev/null || true`);
    } catch {
      // ignore — worktree may already be locked/unlocked
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("vector A: tracked+committed symlink escape → ValidationError, secret does not leak", async () => {
    fs.symlinkSync(secretPath, path.join(workspacePath, "link.txt"), "file");
    execSync(`git -C ${workspacePath} add link.txt && git -C ${workspacePath} commit -qm add-link`);
    await expect(driver.diffFile("link.txt")).rejects.toThrow("Invalid file path");
  });

  it("vector B: untracked symlink escape → ValidationError, secret does not leak", async () => {
    fs.symlinkSync(secretPath, path.join(workspacePath, "link.txt"), "file");
    await expect(driver.diffFile("link.txt")).rejects.toThrow("Invalid file path");
  });

  it("escape via nested symlink one directory deep → ValidationError", async () => {
    fs.mkdirSync(path.join(workspacePath, "docs"));
    fs.symlinkSync(secretPath, path.join(workspacePath, "docs/notes"), "file");
    await expect(driver.diffFile("docs/notes")).rejects.toThrow("Invalid file path");
  });

  it("regression: a regular (non-symlink) changed file still returns its new content", async () => {
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello CHANGED\n");
    const outcome = await driver.diffFile("README.md");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.new_content).toBe("hello CHANGED\n");
    }
  });

  it("regression: an in-worktree symlink (target inside the workspace) is still allowed", async () => {
    fs.writeFileSync(path.join(workspacePath, "real.txt"), "inside-the-worktree\n");
    // Relative target so realpath resolves *inside* the workspace.
    fs.symlinkSync("real.txt", path.join(workspacePath, "link.txt"), "file");
    const outcome = await driver.diffFile("link.txt");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.new_content).toBe("inside-the-worktree\n");
    }
  });
});
