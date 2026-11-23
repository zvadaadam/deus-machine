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
const staleFile = { statusCode: 409, message: "This file changed while it was being read." };
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

function afterContentRead(file: string, change: (target: string) => void) {
  vi.spyOn(fs.promises, "readFile").mockImplementationOnce(async () => {
    const target = path.join(root, file);
    const bytes = fs.readFileSync(target);
    change(target);
    return bytes;
  });
}

async function commitBase(files: Record<string, string> = {}, branch = "main") {
  await git("init", "-qb", branch);
  for (const [file, content] of Object.entries(files)) write(file, content);
  await git("add", ".");
  await git("commit", "--allow-empty", "-qm", "Base");
}

function traceGit() {
  const trace = path.join(root, ".git", "trace.jsonl");
  vi.stubEnv("GIT_TRACE2_EVENT", trace);
  return (): string[][] =>
    fs
      .readFileSync(trace, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "start")
      .map((event) => event.argv.slice(1));
}

interface Fixture {
  status: FileChange["status"];
  lines: [added: number, removed: number];
  before: string | null;
  after: string | null;
  from?: string;
}

function rename(from: string, content: string): Fixture {
  return { status: "renamed", from, lines: [0, 0], before: content, after: content };
}

const edited = "line one\nline two\nline three\nline four\n";
const cases: Record<string, Fixture> = {
  "folder/new name.txt": rename("folder/old name.txt", "same\n"),
  "destination/name": rename("source/name", "cross-folder\n"),
  "notes/a.txt": {
    status: "renamed",
    from: "notes",
    lines: [1, 1],
    before: edited + "old\n",
    after: edited + "new\n",
  },
  "café.txt": { status: "modified", lines: [1, 1], before: "avant\n", after: "après\n" },
  "untracked/café.txt": { status: "added", lines: [2, 0], before: null, after: "one\ntwo" },
  'with "quotes" and spaces': {
    status: "modified",
    lines: [1, 0],
    before: "kept\n",
    after: "kept\nextra\n",
  },
  "new.txt": { status: "added", lines: [1, 0], before: null, after: "untracked\n" },
  "committed.txt": { status: "added", lines: [1, 0], before: null, after: "committed\n" },
  "gone.txt": { status: "deleted", lines: [0, 2], before: "gone\nforever\n", after: null },
  "notes/b.txt": { status: "added", lines: [1, 0], before: null, after: "sibling\n" },
  "gone.txt/inner": { status: "added", lines: [1, 0], before: null, after: "descendant\n" },
  ":literal*.txt": {
    status: "modified",
    lines: [1, 0],
    before: "base\n",
    after: "base\nappended\n",
  },
  binary: { status: "modified", lines: [0, 0], before: "before\0", after: "after\0" },
};

describe.each(["C", "de_DE.UTF-8"])("Changes with LANG and LC_ALL set to %s", (locale) => {
  it.each([true, false])(
    "lists, totals and opens each file with core.quotePath=%s",
    async (quotePath) => {
      vi.stubEnv("LANG", locale);
      vi.stubEnv("LC_ALL", locale);
      await git("init", "-qb", "main");
      await git("config", "core.quotePath", String(quotePath));
      for (const [file, { from, before }] of Object.entries(cases)) {
        if (before !== null) write(from ?? file, before);
      }
      await git("add", ".");
      await git("commit", "-qm", "Comparison base");
      await git("switch", "-qc", "work");
      const moved = [];
      for (const [file, { from, after }] of Object.entries(cases)) {
        if (from || after === null) fs.unlinkSync(path.join(root, from ?? file));
        if (from) moved.push(from, file);
      }
      for (const [file, { after }] of Object.entries(cases)) {
        if (after !== null) write(file, after);
      }
      await git("add", "-A", "--", ...moved, "gone.txt", "committed.txt");
      await git("commit", "--only", "-qm", "A change already in HEAD", "--", "committed.txt");

      const driver = resolveNode(workspace, root);
      const files = await getDiffFiles(root, "main");
      expect(files).toHaveLength(Object.keys(cases).length);
      expect(await getDiffStats(root, "main")).toEqual({ additions: 10, deletions: 4 });
      for (const [file, fixture] of Object.entries(cases)) {
        const { from, status, before, after, lines } = fixture;
        const [additions, deletions] = lines;
        expect(files).toContainEqual({
          file,
          status,
          additions,
          deletions,
          ...(from && { previous_path: from }),
        });
        const outcome = await driver.diffFile(file);
        assert(outcome.ok, file);
        expect(outcome).toEqual({
          ok: true,
          file,
          diff: from && before === after ? "" : expect.stringContaining("diff --git"),
          old_content: before?.includes("\0") ? null : (before ?? ""),
          new_content: after?.includes("\0") ? null : (after ?? ""),
        });
        if (outcome.diff) expect(outcome.diff.match(/^diff --git /gm)).toHaveLength(1);
        if (file.includes("café")) expect(outcome.diff).toContain(file);
        if (file === "notes/a.txt") {
          expect(outcome.diff).toContain("--- a/notes\n+++ b/notes/a.txt");
          expect(outcome.diff).toContain("-old\n+new");
          write(file, edited + "old\n");
          expect((await getFileDiff(root, "main", file)).diff).toBe("");
        }
        if (file === "gone.txt") expect(outcome.diff).toContain("-gone\n-forever");
        if (file === "untracked/café.txt") expect(outcome.diff).toContain("+one\n+two");
        if (file === ":literal*.txt") expect(outcome.diff).toContain("+appended");
      }
    }
  );
});

it("distinguishes a missing repository, comparison branch and git executable under the German locale", async () => {
  vi.stubEnv("LANG", "de_DE.UTF-8");
  vi.stubEnv("LC_ALL", "de_DE.UTF-8");
  const driver = resolveNode({ ...workspace, git_default_branch: "comparison" }, root);
  await expect(driver.diffFiles()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: the workspace is not a git repository.",
  });
  await commitBase({}, "topic");
  await expect(driver.diffFiles()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: the comparison branch could not be found.",
  });
  await git("branch", "comparison");
  expect(await driver.diffFiles()).toEqual({ files: [] });
  vi.stubEnv("PATH", root);
  await expect(driver.diffFiles()).rejects.toMatchObject({
    message: "Could not read the changes: git could not finish the read.",
    statusCode: 409,
  });
});

it("uses the remote target first, observes retargeting immediately and expires a cached ref", async () => {
  await commitBase({}, "topic/main");
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
  await commitBase();
  await git("switch", "--orphan", "other");
  await git("commit", "--allow-empty", "-qm", "Unrelated root");
  expect(await getMergeBase(root, "main")).toBe((await git("rev-parse", "HEAD")).trim());
});

it("lists, totals and opens edit/edit and delete/modify conflicts during a merge", async () => {
  await commitBase({
    edited: "edited base\n",
    "ours-deleted": "ours-deleted base\n",
    "theirs-deleted": "theirs-deleted base\n",
  });
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
  expect(Array.from(index.values(), ({ change }) => change)).toEqual([
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
    await commitBase({ tracked: "base\n" });
    await git("config", config, "true");
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
  const before = "one\ntwo\n";
  const after = "one\nTWO\nthree\n";
  await commitBase({ [file]: before });
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
    diff: expect.stringContaining(" one\n-two\n+TWO\n+three"),
  });
});

it("classifies a git failure by its exit status even when its diagnostic names a private path", async () => {
  await commitBase({ tracked: "before\n" });
  write("tracked", "after\n");
  await git("config", "diff.orderFile", "private/not a git repository");
  await expect(resolveNode(workspace, root).diffStats()).rejects.toMatchObject({
    statusCode: 409,
    message: "Could not read the changes: git failed (128).",
  });
  await git("config", "--unset", "diff.orderFile");
  expect(await getDiffStats(root, "main")).toEqual({ additions: 1, deletions: 1 });
});

async function stageSubmodule(file: string) {
  await git("init", "-qb", "main", file);
  await git("-C", file, "commit", "--allow-empty", "-qm", "Nested base");
  await git("add", "--", file);
  return (await git("-C", file, "rev-parse", "HEAD")).trim();
}

it.each(["diff", "log"])("shows only commit pointers with diff.submodule=%s", async (format) => {
  await git("init", "-qb", "main");
  const oldCommit = await stageSubmodule("sub");
  await git("commit", "-qm", "Base");
  write("sub/nested.txt", "nested contents\n");
  await git("-C", "sub", "add", "nested.txt");
  await git("-C", "sub", "commit", "-qm", "Moved gitlink");
  const newCommit = (await git("-C", "sub", "rev-parse", "HEAD")).trim();
  await git("config", "diff.submodule", format);
  const reads = vi.spyOn(fs.promises, "readFile");
  const commands = traceGit();
  const detail = await getFileDiff(root, "main", "sub");
  expect(detail).toMatchObject({ file: "sub", old_content: null, new_content: null });
  expect(detail.diff.split("\n")).toEqual([
    "diff --git a/sub b/sub",
    expect.stringMatching(/^index [a-f0-9]+\.\.[a-f0-9]+ 160000$/),
    "--- a/sub",
    "+++ b/sub",
    "@@ -1 +1 @@",
    `-Subproject commit ${oldCommit}`,
    `+Subproject commit ${newCommit}`,
    "",
  ]);
  expect(reads).not.toHaveBeenCalled();
  expect(commands().some((args) => args.includes("cat-file"))).toBe(false);
});

it.each([
  { kind: "a directory", ordinary: "sub/plain.txt", staged: true, sections: 1 },
  { kind: "a staged file", ordinary: "sub", staged: true, sections: 2 },
  { kind: "an untracked file", ordinary: "sub", staged: false, sections: 2 },
])("opens sub when replaced by $kind", async ({ ordinary, staged, sections }) => {
  await commitBase({ [ordinary]: "regular content\n" });
  await git("rm", "--", ordinary);
  const commit = await stageSubmodule("sub");
  const headers = Array(sections).fill("diff --git a/sub b/sub");
  const added = await getFileDiff(root, "main", "sub");
  expect(added.diff.match(/^diff --git .*$/gm)).toEqual(headers);
  expect(added.diff).toContain(`+Subproject commit ${commit}\n`);

  await git("commit", "-qm", "Submodule base");
  await git("rm", "--cached", "--", "sub");
  fs.rmSync(path.join(root, "sub"), { recursive: true });
  write(ordinary, "first line\nsecond line\n");
  if (staged) await git("add", "--", ordinary);
  const removed = await getFileDiff(root, "main", "sub");
  expect(removed.diff.match(/^diff --git .*$/gm)).toEqual(["diff --git a/sub b/sub"]);
  if (ordinary === "sub") {
    expect(added.diff).toContain("-regular content\n");
    expect(await getDiffFiles(root, "main")).toEqual([
      { file: "sub", status: "modified", additions: 2, deletions: 1 },
    ]);
    expect(removed).toMatchObject({ old_content: "", new_content: "first line\nsecond line\n" });
    expect(removed.diff).toContain(
      "--- /dev/null\n+++ b/sub\n@@ -0,0 +1,2 @@\n+first line\n+second line\n"
    );
  } else {
    expect(removed.diff).toContain(`-Subproject commit ${commit}\n`);
  }
});

it.each([false, true])("keeps both modes when the base file is a symlink=%s", async (wasLink) => {
  await commitBase({ target: "contents of the link target\n" });
  const file = path.join(root, "kind");
  function place(link: boolean, content: string) {
    if (link) fs.symlinkSync(content, file);
    else write("kind", content);
  }
  place(wasLink, "target");
  await git("add", "kind");
  await git("commit", "-qm", "Original kind");
  for (const content of ["target", "different"]) {
    fs.unlinkSync(file);
    place(!wasLink, content);
    const detail = await getFileDiff(root, "main", "kind");
    expect(detail.old_content).toBe("target");
    expect(detail.new_content).toBe(content);
    expect(detail.diff.match(/^diff --git .*$/gm)).toEqual(
      Array(2).fill("diff --git a/kind b/kind")
    );
    expect(detail.diff).toContain(`deleted file mode ${wasLink ? "120000" : "100644"}`);
    expect(detail.diff).toContain(`new file mode ${wasLink ? "100644" : "120000"}`);
    expect(detail.diff).toContain(`+${content}\n`);
  }
});

it("reads the current checkout for a list and totals while an older list is still counting", async () => {
  await commitBase({ tracked: "base\n" });
  await git("switch", "-qc", "first");
  write("tracked", "first\n");
  await git("commit", "-qam", "First checkout");
  write("waiting", "one\n");
  const counting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(fs.promises, "readFile").mockImplementationOnce(async () => {
    const bytes = fs.readFileSync(path.join(root, "waiting"));
    counting.resolve();
    await release.promise;
    return bytes;
  });
  const commands = traceGit();
  const first = getDiffFiles(root, "main");
  try {
    await counting.promise;
    await git("switch", "-qc", "second", "main");
    write("added", "two\nlines\n");
    await git("add", "added");
    const [files, stats] = await Promise.all([
      getDiffFiles(root, "main"),
      getDiffStats(root, "main"),
    ]);
    expect(files.map(({ file }) => file)).toEqual(["added", "waiting"]);
    expect(stats).toEqual({ additions: 3, deletions: 0 });
  } finally {
    release.resolve();
  }
  expect((await first).map(({ file }) => file)).toEqual(["tracked", "waiting"]);
  expect(commands().filter((args) => args.includes("--raw"))).toHaveLength(3);
  expect(commands().filter((args) => args.includes("ls-files"))).toHaveLength(3);
});

it("refuses an added file replaced by a directory between its contents and patch", async () => {
  await commitBase();
  write("added", "original\n");
  await git("add", "added");
  afterContentRead("added", (target) => {
    fs.unlinkSync(target);
    write("added/null", "child contents\n");
  });
  const commands = traceGit();
  await expect(resolveNode(workspace, root).diffFile("added")).rejects.toMatchObject(staleFile);
  expect(commands().some((args) => args.includes("--no-index"))).toBe(true);
});

it.each(["modified", "renamed"])("refuses a %s file removed after enumeration", async (status) => {
  await commitBase({ original: "before\n" });
  const file = status === "renamed" ? "moved" : "original";
  const target = path.join(root, file);
  if (status === "renamed") {
    await git("mv", "original", file);
    afterContentRead(file, fs.unlinkSync);
  } else {
    write(file, "after\n");
    vi.spyOn(fs.promises, "lstat").mockImplementationOnce(async () => {
      fs.unlinkSync(target);
      return fs.lstatSync(target, { bigint: true });
    });
  }
  await expect(resolveNode(workspace, root).diffFile(file)).rejects.toMatchObject(staleFile);
});

it.each(["size", "mtime", "inode"])(
  "refuses a working file whose %s changes during the patch",
  async (field) => {
    await commitBase({ tracked: "base\n" });
    write("tracked", "first\n");
    const stamp = new Date("2025-01-01T00:00:00Z");
    fs.utimesSync(path.join(root, "tracked"), stamp, stamp);
    afterContentRead("tracked", (target) => {
      if (field === "inode") {
        write("swap", "later\n");
        fs.renameSync(path.join(root, "swap"), target);
      } else {
        write("tracked", field === "size" ? "more bytes\n" : "later\n");
      }
      fs.utimesSync(target, stamp, field === "mtime" ? new Date(stamp.getTime() + 1000) : stamp);
    });
    await expect(getFileDiff(root, "main", "tracked")).rejects.toMatchObject(staleFile);
  }
);

it("opens only the selected file and scopes the untracked lookup to its literal name", async () => {
  await commitBase({ tracked: "before\n" });
  write("tracked", "after\n");
  const file = "new[1].txt";
  write(file, "selected\n");
  write("new1.txt", "sibling\n");
  write("folder/child", "descendant\n");
  const reads = vi.spyOn(fs.promises, "readFile");
  const commands = traceGit();
  const untrackedLookups = () => commands().filter((args) => args.includes("ls-files"));

  expect((await getFileDiff(root, "main", "tracked")).new_content).toBe("after\n");
  expect(reads.mock.calls).toEqual([[path.join(root, "tracked")]]);
  expect(untrackedLookups()).toEqual([]);
  reads.mockClear();
  expect((await getFileDiff(root, "main", file)).new_content).toBe("selected\n");
  expect(reads.mock.calls).toEqual([[path.join(root, file)]]);
  expect(untrackedLookups()).toEqual([
    ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", file],
  ]);
  await expect(getFileDiff(root, "main", "folder")).rejects.toMatchObject({ statusCode: 404 });
});

it("diffs a link itself and refuses files outside the change list", async () => {
  await commitBase({ ".gitignore": "ignored\n" });
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
  await commitBase({ large });
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
  await expect(runGit(args, { cwd: root, maxOutputBytes: 5 })).rejects.toMatchObject({
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

it("streams all stderr and keeps its last MiB for a failed git command", async () => {
  await git("init", "-qb", "main");
  const full = "HEAD" + "é".repeat(1024 * 1024) + "END";
  write("noise", full);
  const chunks: string[] = [];
  const failure = await runGit(["-c", "alias.noisy=!cat noise >&2; exit 23", "noisy"], {
    cwd: root,
    onStderr: (chunk) => chunks.push(chunk),
  }).catch((error: unknown) => error);
  assert(failure instanceof GitError);
  expect(failure.code).toBe(23);
  expect(chunks.join("")).toBe(full);
  expect(failure.stderr).toBe("é".repeat(Math.floor((1024 * 1024 - 3) / 2)) + "END");
});

it.each(["timeout", "abort", "overflow"])(
  "settles on %s while a detached post-commit helper holds the pipes",
  async (stop) => {
    await git("init", "-qb", "main");
    const hook = path.join(root, ".git", "hooks", "post-commit");
    write(
      "detach.cjs",
      `const helper = require("node:child_process").spawn("/bin/sleep", ["12"], { detached: true, stdio: "inherit" });
require("node:fs").writeFileSync("helper.pid", String(helper.pid));
helper.unref();`
    );
    fs.writeFileSync(
      hook,
      `#!/bin/sh
trap '' TERM
sleep 12 >/dev/null 2>&1 &
echo $! > member.pid
trap - TERM
exec "${process.execPath}" detach.cjs
`,
      { mode: 0o755 }
    );
    const controller = new AbortController();
    const started = Date.now();
    const running = runGit(
      ["-c", "alias.finish=!git commit -q --allow-empty -m fixture && printf done", "finish"],
      {
        cwd: root,
        timeoutMs: stop === "timeout" ? 750 : 10_000,
        signal: controller.signal,
        maxOutputBytes: stop === "overflow" ? 1 : undefined,
      }
    ).catch((error: unknown) => error);
    const pid = (name: string) => Number(fs.readFileSync(path.join(root, name + ".pid"), "utf8"));
    try {
      await vi.waitFor(() => expect(pid("helper")).toBeGreaterThan(0));
      if (stop === "abort") controller.abort(new Error("Workspace archived"));
      const failure = await running;
      if (stop === "abort") expect(failure).toBe(controller.signal.reason);
      else expect(failure).toMatchObject({ code: null, timedOut: stop === "timeout" });
      expect(Date.now() - started).toBeLessThan(4000);
      await vi.waitFor(() => expect(() => process.kill(pid("member"), 0)).toThrow());
      expect(process.kill(pid("helper"), 0)).toBe(true);
    } finally {
      if (fs.existsSync(path.join(root, "helper.pid"))) process.kill(pid("helper"), "SIGKILL");
    }
  }
);

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
