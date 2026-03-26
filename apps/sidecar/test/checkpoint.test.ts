import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));
vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import { createCheckpoint } from "../agents/claude/checkpoint";

describe("createCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a start checkpoint with correct git commands", () => {
    mockExecFileSync
      .mockReturnValueOnce("abc123def456\n") // rev-parse HEAD
      .mockReturnValueOnce("tree123\n") // write-tree
      .mockReturnValueOnce("commit456\n") // commit-tree
      .mockReturnValueOnce(""); // update-ref

    createCheckpoint("sess-1", "turn-1", "start", "/test/repo", "test");

    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["write-tree"], {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit-tree", "tree123", "-p", "abc123def456"]),
      expect.objectContaining({ cwd: "/test/repo" })
    );

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/deus-checkpoints/session-sess-1-turn-turn-1-start",
        "commit456",
      ]),
      expect.objectContaining({ cwd: "/test/repo" })
    );
  });

  it("creates an end checkpoint", () => {
    mockExecFileSync
      .mockReturnValueOnce("headref\n")
      .mockReturnValueOnce("treeref\n")
      .mockReturnValueOnce("commitref\n")
      .mockReturnValueOnce("");

    createCheckpoint("sess-2", "turn-5", "end", "/workspace", "handler");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/deus-checkpoints/session-sess-2-turn-turn-5-end",
      ]),
      expect.any(Object)
    );
  });

  it("includes checkpoint metadata in commit message", () => {
    mockExecFileSync
      .mockReturnValueOnce("headref\n")
      .mockReturnValueOnce("treeref\n")
      .mockReturnValueOnce("commitref\n")
      .mockReturnValueOnce("");

    createCheckpoint("sess-1", "turn-1", "start", "/repo", "test");

    const commitTreeArgs = mockExecFileSync.mock.calls[2][1];
    const messageIdx = commitTreeArgs.indexOf("-m");
    const commitMessage = commitTreeArgs[messageIdx + 1];
    expect(commitMessage).toContain("checkpoint:session-sess-1-turn-turn-1-start");
  });

  it("skips checkpoint for unresolved git state", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mergeError = new Error(
      "Command failed: git write-tree\nfile.txt: unmerged (123)\nfatal: git-write-tree: error building trees"
    );
    mockExecFileSync.mockImplementation(() => {
      throw mergeError;
    });

    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips checkpoint when merge message is present", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mergeError = new Error("fatal: merge in progress");
    mockExecFileSync.mockImplementation(() => {
      throw mergeError;
    });

    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not treat unrelated status 128 failures as merge state", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("fatal: repository corrupt");
    (error as Error & { status?: number }).status = 128;
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "test Checkpoint start failed:",
      "fatal: repository corrupt"
    );
  });

  it("logs error for non-merge failures", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("permission denied");
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("test Checkpoint start failed:", "permission denied");
  });
});
