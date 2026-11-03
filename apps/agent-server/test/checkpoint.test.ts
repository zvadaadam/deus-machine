import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));
vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

/** git answers each call in turn: an output, or an error. */
function gitAnswers(...answers: Array<string | Error>) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      done: (e: Error | null, out: string) => void
    ) => {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) done(next, "");
      else done(null, next ?? "");
    }
  );
}

import { createCheckpoint } from "../agents/core/checkpoint";

describe("createCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a start checkpoint with correct git commands", async () => {
    gitAnswers("abc123def456\n", "tree123\n", "commit456\n", ""); // update-ref

    await createCheckpoint("sess-1", "turn-1", "start", "/test/repo", "test");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: "/test/repo",
        encoding: "utf-8",
        timeout: 15_000,
      },
      expect.any(Function)
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["write-tree"],
      {
        cwd: "/test/repo",
        encoding: "utf-8",
        timeout: 15_000,
      },
      expect.any(Function)
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit-tree", "tree123", "-p", "abc123def456"]),
      expect.objectContaining({ cwd: "/test/repo" }),
      expect.any(Function)
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/deus-checkpoints/session-sess-1-turn-turn-1-start",
        "commit456",
      ]),
      expect.objectContaining({ cwd: "/test/repo" }),
      expect.any(Function)
    );
  });

  it("creates an end checkpoint", async () => {
    gitAnswers("headref\n", "treeref\n", "commitref\n", "");

    await createCheckpoint("sess-2", "turn-5", "end", "/workspace", "handler");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/deus-checkpoints/session-sess-2-turn-turn-5-end",
      ]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("includes checkpoint metadata in commit message", async () => {
    gitAnswers("headref\n", "treeref\n", "commitref\n", "");

    await createCheckpoint("sess-1", "turn-1", "start", "/repo", "test");

    const commitTreeArgs = mockExecFile.mock.calls[2][1];
    const messageIdx = commitTreeArgs.indexOf("-m");
    const commitMessage = commitTreeArgs[messageIdx + 1];
    expect(commitMessage).toContain("checkpoint:session-sess-1-turn-turn-1-start");
  });

  it("skips checkpoint for unresolved git state", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mergeError = new Error(
      "Command failed: git write-tree\nfile.txt: unmerged (123)\nfatal: git-write-tree: error building trees"
    );
    gitAnswers(mergeError);

    await expect(
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips checkpoint when merge message is present", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mergeError = new Error("fatal: merge in progress");
    gitAnswers(mergeError);

    await expect(
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not treat unrelated status 128 failures as merge state", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("fatal: repository corrupt");
    (error as Error & { status?: number }).status = 128;
    gitAnswers(error);

    await expect(
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "test Checkpoint start failed:",
      "fatal: repository corrupt"
    );
  });

  it("logs error for non-merge failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("permission denied");
    gitAnswers(error);

    await expect(
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("test Checkpoint start failed:", "permission denied");
  });
});
