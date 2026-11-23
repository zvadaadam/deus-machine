import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCheckpoint } from "../agents/core/checkpoint";

let cwd: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "deus-checkpoint-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(cwd, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Checkpoint Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(path.join(cwd, "file"), "initial");
  git("add", "file");
  git("commit", "-qm", "first");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

it.each(["start", "end"] as const)(
  "records HEAD and the staged tree in a private %s ref",
  async (type) => {
    writeFileSync(path.join(cwd, "file"), "staged");
    git("add", "file");
    writeFileSync(path.join(cwd, "file"), "unstaged");
    const head = git("rev-parse", "HEAD");
    const tree = git("write-tree");
    const id = `session-sess-turn-turn-${type}`;
    const ref = `refs/deus-checkpoints/${id}`;

    await createCheckpoint("sess", "turn", type, cwd, "test");

    expect(git("rev-parse", `${ref}^`)).toBe(head);
    expect(git("rev-parse", `${ref}^{tree}`)).toBe(tree);
    expect(git("show", `${ref}:file`)).toBe("staged");
    expect(git("log", "-1", "--format=%B", ref)).toContain(
      `checkpoint:${id}\nhead ${head}\nindex-tree ${tree}\ncreated `
    );
    expect(git("rev-parse", "HEAD")).toBe(head);
  }
);

it("skips an unmerged index and checkpoints it as soon as the conflict is staged", async () => {
  git("switch", "-qc", "side");
  writeFileSync(path.join(cwd, "file"), "side");
  git("commit", "-qam", "side");
  git("switch", "-q", "main");
  writeFileSync(path.join(cwd, "file"), "main");
  git("commit", "-qam", "main");
  expect(() => git("merge", "side")).toThrow();
  const nested = path.join(cwd, "src");
  mkdirSync(nested);
  git("config", "diff.relative", "true");
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");

  await createCheckpoint("sess", "turn", "start", nested, "test");
  expect(log).toHaveBeenCalledWith("test Checkpoint start skipped: unmerged index");
  expect(error).not.toHaveBeenCalled();
  expect(git("for-each-ref", "refs/deus-checkpoints/")).toBe("");

  writeFileSync(path.join(cwd, "file"), "resolved");
  git("add", "file");
  await createCheckpoint("sess", "turn", "end", cwd, "test");
  expect(git("show", "refs/deus-checkpoints/session-sess-turn-turn-end:file")).toBe("resolved");
});

it("reports a broken index object even when the file is named unmerged", async () => {
  const missing = "1".repeat(git("rev-parse", "HEAD").length);
  git("update-index", "--add", "--cacheinfo", "100644", missing, "unmerged");
  const error = vi.spyOn(console, "error");
  await createCheckpoint("sess", "turn", "start", cwd, "test");
  expect(error).toHaveBeenCalledWith(
    "test Checkpoint start failed:",
    expect.stringContaining("git write-tree")
  );
  expect(git("for-each-ref", "refs/deus-checkpoints/")).toBe("");
});
