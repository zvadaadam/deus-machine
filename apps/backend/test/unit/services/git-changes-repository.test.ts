import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { GitError, runGit } from "@shared/lib/git-process";
import type { FileChange } from "@shared/types/workspace";
import {
  detectDefaultBranch,
  getDiffFiles,
  getDiffStats,
  getFileDiff,
  getMergeBase,
  parseDiffFiles,
  resolveParentBranch,
} from "../../../src/services/git.service";
import { resolveNode } from "../../../src/services/node/driver";

let root: string;
const git = (...args: string[]) => runGit(args, { cwd: root });
const workspace = {
  kind: "worktree",
  id: "local",
  current_session_id: null,
  init_stage: null,
  git_target_branch: null,
  git_default_branch: "main",
} as const;

beforeEach(() => {
  const scratch = path.resolve(".context");
  fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(path.join(scratch, "git-changes-"));
  // A fresh folder must not discover this checkout above it.
  vi.stubEnv("GIT_CEILING_DIRECTORIES", scratch);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_AUTHOR_NAME", "Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "test@localhost");
  vi.stubEnv("GIT_COMMITTER_NAME", "Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "test@localhost");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

type Fixture = FileChange & { before: string | null; after: string | null };

const edited = "line one\nline two\nline three\nline four\n";
const cases: Fixture[] = [
  {
    file: "folder/new name.txt",
    previous_path: "folder/old name.txt",
    status: "renamed",
    additions: 0,
    deletions: 0,
    before: "same\n",
    after: "same\n",
  },
  {
    file: "destination/name",
    previous_path: "source/name",
    status: "renamed",
    additions: 0,
    deletions: 0,
    before: "cross-folder\n",
    after: "cross-folder\n",
  },
  {
    file: "edited name",
    previous_path: "old edited",
    status: "renamed",
    additions: 1,
    deletions: 1,
    before: edited + "old\n",
    after: edited + "new\n",
  },
  {
    file: "café.txt",
    status: "modified",
    additions: 1,
    deletions: 1,
    before: "avant\n",
    after: "après\n",
  },
  {
    file: "untracked/café.txt",
    status: "added",
    additions: 2,
    deletions: 0,
    before: null,
    after: "one\ntwo",
  },
  {
    file: 'with "quotes" and spaces',
    status: "modified",
    additions: 1,
    deletions: 0,
    before: "kept\n",
    after: "kept\nextra\n",
  },
  {
    file: "new.txt",
    status: "added",
    additions: 1,
    deletions: 0,
    before: null,
    after: "untracked\n",
  },
  {
    file: "committed.txt",
    status: "added",
    additions: 1,
    deletions: 0,
    before: null,
    after: "committed\n",
  },
  {
    file: "deleted",
    status: "deleted",
    additions: 0,
    deletions: 2,
    before: "gone\nforever\n",
    after: null,
  },
  {
    file: ":literal*.txt",
    status: "modified",
    additions: 1,
    deletions: 0,
    before: "base\n",
    after: "base\nappended\n",
  },
  {
    file: "binary",
    status: "modified",
    additions: 0,
    deletions: 0,
    before: "before\0",
    after: "after\0",
  },
];

describe.each(["C", "de_DE.UTF-8"])("Changes with LANG and LC_ALL set to %s", (locale) => {
  it.each([true, false])(
    "lists, totals and opens each file with core.quotePath=%s",
    async (quotePath) => {
      vi.stubEnv("LANG", locale);
      vi.stubEnv("LC_ALL", locale);
      await git("init", "-qb", "main");
      await git("config", "core.quotePath", String(quotePath));
      for (const { file, previous_path, before } of cases) {
        if (before !== null) write(previous_path ?? file, before);
      }
      await git("add", ".");
      await git("commit", "-qm", "Comparison base");
      await git("switch", "-qc", "work");
      for (const { file, previous_path, after } of cases) {
        if (previous_path) {
          fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
          await git("mv", "--", previous_path, file);
        }
        if (after === null) fs.unlinkSync(path.join(root, file));
        else write(file, after);
      }
      await git("add", "committed.txt");
      await git("commit", "--only", "-qm", "A change already in HEAD", "--", "committed.txt");

      const driver = resolveNode(workspace, root);
      const files = await getDiffFiles(root, "main");
      expect(files).toHaveLength(cases.length);
      expect(await getDiffStats(root, "main")).toEqual({ additions: 8, deletions: 4 });
      for (const { before, after, ...change } of cases) {
        expect(files).toContainEqual(change);
        const outcome = await driver.diffFile(change.file);
        assert(outcome.ok, change.file);
        expect(outcome).toEqual({
          ok: true,
          file: change.file,
          diff: expect.stringContaining("diff --git"),
          old_content: before?.includes("\0") ? null : (before ?? ""),
          new_content: after?.includes("\0") ? null : (after ?? ""),
        });
        if (change.previous_path) {
          expect(outcome.diff).toContain(`rename from ${change.previous_path}`);
          expect(outcome.diff).toContain(`rename to ${change.file}`);
        }
        if (change.file.includes("café")) expect(outcome.diff).toContain(change.file);
        if (change.file === "edited name") expect(outcome.diff).toContain("-old\n+new");
        if (change.file === "untracked/café.txt") expect(outcome.diff).toContain("+one\n+two");
        if (change.file === ":literal*.txt") expect(outcome.diff).toContain("+appended");
      }
    }
  );
});

it("reports a non-repository and a missing comparison branch under the German locale and retries a missing ref", async () => {
  vi.stubEnv("LANG", "de_DE.UTF-8");
  vi.stubEnv("LC_ALL", "de_DE.UTF-8");
  const driver = resolveNode({ ...workspace, git_default_branch: "comparison" }, root);
  await expect(driver.diffFiles()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: the workspace is not a git repository.",
  });
  await git("init", "-qb", "topic");
  await git("commit", "--allow-empty", "-qm", "Topic");
  await expect(driver.diffFiles()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: the comparison branch could not be found.",
  });
  await git("branch", "comparison");
  expect(await driver.diffFiles()).toEqual({ files: [] });
});

it("uses the remote target first, observes retargeting immediately and expires a cached ref", async () => {
  await git("init", "-qb", "topic/main");
  await git("commit", "--allow-empty", "-qm", "Topic");
  expect(await detectDefaultBranch(root)).toBe("topic/main");
  await git("branch", "develop");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  expect(await detectDefaultBranch(root)).toBe("main");
  expect(await resolveParentBranch(root, "develop", "main")).toBe("origin/main");
  await git("update-ref", "refs/remotes/origin/develop", "HEAD");
  expect(await resolveParentBranch(root, "develop", "main")).toBe("origin/main");
  expect(await resolveParentBranch(root, "origin/develop", "main")).toBe("origin/develop");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
  expect(await resolveParentBranch(root, "develop", "main")).toBe("origin/develop");
});

it("compares unrelated histories to HEAD", async () => {
  await git("init", "-qb", "main");
  await git("commit", "--allow-empty", "-qm", "Base");
  await git("switch", "--orphan", "other");
  await git("commit", "--allow-empty", "-qm", "Unrelated root");
  expect(await getMergeBase(root, "main")).toBe("HEAD");
});

it("lists, totals and opens edit/edit and delete/modify conflicts during a merge", async () => {
  await git("init", "-qb", "main");
  for (const file of ["edited", "ours-deleted", "theirs-deleted"]) write(file, `${file} base\n`);
  await git("add", ".");
  await git("commit", "-qm", "Base");
  await git("switch", "-qc", "topic");
  write("edited", "topic version\n");
  write("ours-deleted", "topic kept\n");
  await git("rm", "theirs-deleted");
  await git("commit", "-qam", "Topic");
  await git("switch", "main");
  write("edited", "main version\n");
  write("theirs-deleted", "main kept\n");
  await git("rm", "ours-deleted");
  await git("commit", "-qam", "Main");
  await expect(git("merge", "topic")).rejects.toMatchObject({ code: 1 });

  const index = parseDiffFiles(await git("diff", "--raw", "--numstat", "-z"));
  expect([...index.values()]).toEqual([
    { file: "edited", status: "modified", additions: 4, deletions: 0 },
    { file: "ours-deleted", status: "modified", additions: 0, deletions: 0 },
    { file: "theirs-deleted", status: "modified", additions: 0, deletions: 0 },
  ]);
  expect(await getDiffFiles(root, "topic")).toEqual([
    { file: "edited", status: "modified", additions: 5, deletions: 1 },
    { file: "ours-deleted", status: "modified", additions: 1, deletions: 1 },
    { file: "theirs-deleted", status: "modified", additions: 1, deletions: 1 },
  ]);
  expect(await getDiffStats(root, "topic")).toEqual({ additions: 7, deletions: 3 });
  for (const [file, content] of [
    ["edited", "<<<<<<< HEAD\nmain version\n=======\ntopic version\n>>>>>>> topic\n"],
    ["ours-deleted", "topic kept\n"],
    ["theirs-deleted", "main kept\n"],
  ]) {
    expect(await getFileDiff(root, "topic", file)).toEqual({
      file,
      diff: expect.stringContaining(`+${content.split("\n")[0]}`),
      old_content: `${file} base\n`,
      new_content: content,
    });
  }
  expect(await getDiffFiles(root, "main")).toEqual([
    { file: "edited", status: "modified", additions: 4, deletions: 0 },
    { file: "ours-deleted", status: "added", additions: 1, deletions: 0 },
  ]);
});

it.each(["diff.noprefix", "diff.mnemonicPrefix"])(
  "pins patch prefixes with %s enabled",
  async (config) => {
    await git("init", "-qb", "main");
    await git("config", config, "true");
    write("tracked", "base\n");
    await git("add", "tracked");
    await git("commit", "-qm", "Base");
    write("tracked", "changed\n");
    write("untracked", "new\n");
    for (const [file, oldLabel] of [
      ["tracked", "a/tracked"],
      ["untracked", "/dev/null"],
    ]) {
      const { diff } = await getFileDiff(root, "main", file);
      expect(diff).toContain(`diff --git a/${file} b/${file}\n`);
      expect(diff).toContain(`--- ${oldLabel}\n+++ b/${file}\n`);
    }
  }
);

it("counts a staged deletion and its untracked replacement as one modified file", async () => {
  const file = "notes.txt";
  const before = "old one\nold two\n";
  const after = "new one\nnew two\nnew three\n";
  await git("init", "-qb", "main");
  write(file, before);
  await git("add", file);
  await git("commit", "-qm", "Tracked notes");
  await git("rm", "--cached", "--", file);
  write(file, after);

  expect(await getDiffFiles(root, "main")).toEqual([
    { file, status: "modified", additions: 3, deletions: 2 },
  ]);
  expect(await getDiffStats(root, "main")).toEqual({ additions: 3, deletions: 2 });
  expect(await resolveNode(workspace, root).diffFile(file)).toMatchObject({
    ok: true,
    file,
    old_content: before,
    new_content: after,
    diff: expect.stringContaining("deleted file mode"),
  });
});

it("classifies a git failure by its exit status even when its diagnostic names a private path", async () => {
  await git("init", "-qb", "main");
  write("tracked", "before\n");
  await git("add", "tracked");
  await git("commit", "-qm", "Base");
  write("tracked", "after\n");
  await git("config", "diff.orderFile", "private/not a git repository");
  await expect(resolveNode(workspace, root).diffStats()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: git failed (128).",
  });
});

it("diffs a link itself and refuses files outside the change list", async () => {
  await git("init", "-qb", "main");
  write(".gitignore", "ignored\n");
  await git("add", ".gitignore");
  await git("commit", "-qm", "Ignore a file");
  write("ignored", "first\nsecond\n");
  fs.symlinkSync("ignored", path.join(root, "link"));
  const driver = resolveNode(workspace, root);
  expect(await driver.diffFiles()).toEqual({
    files: [{ file: "link", status: "added", additions: 1, deletions: 0 }],
  });
  expect(await driver.diffFile("link")).toMatchObject({ ok: true, new_content: "ignored" });
  for (const file of [".gitignore", "ignored"]) {
    await expect(driver.diffFile(file)).rejects.toMatchObject({ statusCode: 404 });
  }
});

it("keeps a small patch for an oversized blob and refuses an oversized patch", async () => {
  const large = ("x".repeat(1023) + "\n").repeat(10 * 1024 + 1);
  await git("init", "-qb", "main");
  write("large", large);
  await git("add", "large");
  await git("commit", "-qm", "Large file");
  fs.appendFileSync(path.join(root, "large"), "extra line\n");
  const driver = resolveNode(workspace, root);
  expect(await driver.diffFile("large")).toMatchObject({
    ok: true,
    diff: expect.stringContaining("+extra line"),
    old_content: null,
    new_content: null,
  });
  write("untracked", large);
  await expect(driver.diffFile("untracked")).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: git could not finish the read.",
  });
});

it("stops the process group when stdout exceeds its byte limit", async () => {
  await git("init", "-qb", "main");
  const args = [
    "-c",
    "alias.print=!trap '' TERM; sleep 3 >/dev/null 2>&1 & echo $! > child.pid; trap - TERM; printf 'ééé'; wait; touch finished",
    "print",
  ];
  const failure = await runGit(args, { cwd: root, maxOutputBytes: 5 }).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(GitError);
  expect(failure).toMatchObject({
    code: null,
    timedOut: false,
    stdout: "",
    cause: { message: "Git output exceeded its byte limit by 1 (limit 5, received 6)." },
  });
  const pid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  expect(fs.existsSync(path.join(root, "finished"))).toBe(false);
  expect(await runGit(args, { cwd: root, maxOutputBytes: 6 })).toBe("ééé");
});

it("keeps git's exit status when shutdown closes a helper holding stdout", async () => {
  await git("init", "-qb", "main");
  vi.resetModules();
  const runner = await import("@shared/lib/git-process");
  const groups = await import("@shared/lib/process-groups");
  const output = runner.runGit(
    ["-c", "alias.finish=!sleep 10 & echo $PPID > git.pid; printf done", "finish"],
    { cwd: root }
  );
  try {
    await vi.waitFor(() => {
      const pid = Number(fs.readFileSync(path.join(root, "git.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    });
  } finally {
    groups.stopProcessGroups();
  }
  await expect(output).resolves.toBe("done");
});
