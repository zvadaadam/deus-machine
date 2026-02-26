import { describe, it, expect, vi, beforeEach } from "vitest";

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

  it("creates a start checkpoint with correct git commands", () => {
    mockExecFileSync
      .mockReturnValueOnce("abc123def456\n") // rev-parse HEAD
      .mockReturnValueOnce("tree123\n") // write-tree
      .mockReturnValueOnce("commit456\n") // commit-tree
      .mockReturnValueOnce(""); // update-ref

    createCheckpoint("sess-1", "turn-1", "start", "/test/repo", "test");

    // Verify git rev-parse HEAD
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    // Verify git write-tree
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["write-tree"], {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    // Verify git commit-tree (with tree and parent)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit-tree", "tree123", "-p", "abc123def456"]),
      expect.objectContaining({ cwd: "/test/repo" })
    );

    // Verify git update-ref with correct checkpoint name
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/opendevs-checkpoints/session-sess-1-turn-turn-1-start",
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

    // Verify update-ref includes the correct checkpoint ref name
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "update-ref",
        "refs/opendevs-checkpoints/session-sess-2-turn-turn-5-end",
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

    // commit-tree is the 3rd call (index 2). Args array is the 2nd param.
    const commitTreeArgs = mockExecFileSync.mock.calls[2][1];
    const messageIdx = commitTreeArgs.indexOf("-m");
    const commitMessage = commitTreeArgs[messageIdx + 1];
    expect(commitMessage).toContain("checkpoint:session-sess-1-turn-turn-1-start");
  });

  it("skips checkpoint during merge (status 128)", () => {
    const mergeError: any = new Error("merge in progress");
    mergeError.status = 128;
    mockExecFileSync.mockImplementation(() => {
      throw mergeError;
    });

    // Should not throw
    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
  });

  it("skips checkpoint when merge message is present", () => {
    const mergeError = new Error("fatal: merge in progress");
    mockExecFileSync.mockImplementation(() => {
      throw mergeError;
    });

    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
  });

  it("logs error for non-merge failures", () => {
    const error = new Error("permission denied");
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    // Should not throw, just log
    expect(() => createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")).not.toThrow();
  });
});
