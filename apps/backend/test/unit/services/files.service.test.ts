import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as git from "@shared/lib/git-process";
import {
  clearCache,
  fuzzySearchFiles,
  invalidateCache,
  listTopFiles,
  readTextFile,
  scanWorkspaceFiles,
} from "../../../src/services/files.service";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deus-files-"));
});
afterEach(() => {
  clearCache();
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, text: string | Buffer = "") {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

it("lists tracked and untracked files, including ignored project settings and names with newlines", async () => {
  execFileSync("git", ["init", "-q", root]);
  expect(await scanWorkspaceFiles(root)).toEqual({ files: [], totalFiles: 0, totalSize: 0 });
  const tracked = write("src/auth/a\nb.ts", "text");
  execFileSync("git", ["-C", root, "add", "--", "src"]);
  const ignore = ".deus/\n*.tmp\n";
  write(".gitignore", ignore);
  write(".deus/environment.json", "{}");
  write(".deus/private");
  write("ignored.tmp");
  write("src/auth/untracked.ts", "123");
  rmSync(tracked);
  invalidateCache(root);

  const tree = await scanWorkspaceFiles(root);
  expect(tree.totalFiles).toBe(4);
  expect(tree.totalSize).toBe(ignore.length + 2 + 3);
  expect(tree.files.map((file) => file.path)).toEqual([".deus", "src", ".gitignore"]);
  expect(tree.files[1].children?.[0].children).toEqual([
    { name: "a\nb.ts", path: "src/auth/a\nb.ts", type: "file", size: 0 },
    { name: "untracked.ts", path: "src/auth/untracked.ts", type: "file", size: 3 },
  ]);
});

it("lists and counts a nested file once during an edit/edit merge conflict", async () => {
  const file = "src/conflict.txt";
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  const commit = (version: string) => {
    write(file, version + "\n");
    run("add", file);
    run("commit", "-qm", version);
  };
  run("init", "-qb", "main");
  run("config", "user.name", "Files Test");
  run("config", "user.email", "files@example.test");
  commit("base");
  run("switch", "-qc", "topic");
  commit("theirs");
  run("switch", "main");
  commit("ours");
  expect(() => run("merge", "topic")).toThrow();
  expect(run("ls-files", "--unmerged").trimEnd().split("\n")).toHaveLength(3);

  const tree = await scanWorkspaceFiles(root);
  expect(tree.files[0].children?.map((node) => node.path)).toEqual([file]);
  expect(tree.totalFiles).toBe(1);
  expect(tree.totalSize).toBe(statSync(path.join(root, file)).size);
});

it("shares a pending scan and honours invalidation before that scan finishes", async () => {
  const first = Promise.withResolvers<string>();
  const read = vi
    .spyOn(git, "runGit")
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce("fresh\0");
  const old = scanWorkspaceFiles(root);
  const shared = scanWorkspaceFiles(root);
  expect(read).toHaveBeenCalledOnce();
  invalidateCache(root);
  const fresh = await scanWorkspaceFiles(root);
  first.resolve("old\0");

  expect((await old).files[0].path).toBe("old");
  expect(await shared).toBe(await old);
  expect((await scanWorkspaceFiles(root)).files[0].path).toBe("fresh");
  expect(await scanWorkspaceFiles(root)).toBe(fresh);
  expect(read).toHaveBeenCalledTimes(2);
});

it("walks folders when git cannot list files, and skips dependency folders", async () => {
  write("src/index.ts");
  write("app.ts");
  write("node_modules/private.ts");
  const tree = await scanWorkspaceFiles(root);
  expect(tree.totalFiles).toBe(2);
  expect(tree.files.map((file) => file.name)).toEqual(["src", "app.ts"]);
});

it("uses the directory walk when ls-files exceeds its output limit", async () => {
  execFileSync("git", ["init", "-q", root]);
  write(".gitignore", "ignored.txt\n");
  write("ignored.txt");
  const run = git.runGit;
  const list = vi
    .spyOn(git, "runGit")
    .mockImplementationOnce((args, options) => run(args, { ...options, maxOutputBytes: 1 }));

  const tree = await scanWorkspaceFiles(root);
  expect(list.mock.calls[0][1].maxOutputBytes).toBe(50 * 1024 * 1024);
  expect(tree.files.map((file) => file.path)).toContain("ignored.txt");
});

it("ranks file mentions by depth or query and honours the limit", async () => {
  execFileSync("git", ["init", "-q", root]);
  write("app.ts");
  write("src/app.ts");
  write("lib/other.js");
  expect((await listTopFiles(root, 1)).map((file) => file.path)).toEqual(["app.ts"]);
  expect((await fuzzySearchFiles(root, "app", 2)).map((file) => file.path)).toEqual([
    "app.ts",
    "src/app.ts",
  ]);
  expect(await fuzzySearchFiles(root, "app", 1)).toHaveLength(1);
  expect(await fuzzySearchFiles(root, "zzzz")).toEqual([]);
});

it("reads text and declines binary content", async () => {
  expect(await readTextFile(write("file.ts", "hello world\n"))).toBe("hello world\n");
  expect(await readTextFile(write("image.png", Buffer.from([65, 0, 65])))).toBeNull();
});
