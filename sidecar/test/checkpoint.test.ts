import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));
vi.mock("child_process", () => ({
  execSync: mockExecSync,
}));

import { createCheckpoint } from "../agents/claude/checkpoint";

describe("createCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a start checkpoint with correct git commands", () => {
    // Mock git rev-parse HEAD
    mockExecSync
      .mockReturnValueOnce("abc123def456\n") // rev-parse HEAD
      .mockReturnValueOnce("tree123\n") // write-tree
      .mockReturnValueOnce("commit456\n") // commit-tree
      .mockReturnValueOnce(""); // update-ref

    createCheckpoint("sess-1", "turn-1", "start", "/test/repo", "test");

    // Verify git rev-parse HEAD
    expect(mockExecSync).toHaveBeenCalledWith("git rev-parse HEAD", {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    // Verify git write-tree
    expect(mockExecSync).toHaveBeenCalledWith("git write-tree", {
      cwd: "/test/repo",
      encoding: "utf-8",
    });

    // Verify git commit-tree (with tree and parent)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git commit-tree tree123 -p abc123def456"),
      expect.objectContaining({ cwd: "/test/repo" })
    );

    // Verify git update-ref with correct checkpoint name
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("refs/conductor-checkpoints/session-sess-1-turn-turn-1-start"),
      expect.objectContaining({ cwd: "/test/repo" })
    );
  });

  it("creates an end checkpoint", () => {
    mockExecSync
      .mockReturnValueOnce("headref\n")
      .mockReturnValueOnce("treeref\n")
      .mockReturnValueOnce("commitref\n")
      .mockReturnValueOnce("");

    createCheckpoint("sess-2", "turn-5", "end", "/workspace", "handler");

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("refs/conductor-checkpoints/session-sess-2-turn-turn-5-end"),
      expect.any(Object)
    );
  });

  it("includes checkpoint metadata in commit message", () => {
    mockExecSync
      .mockReturnValueOnce("headref\n")
      .mockReturnValueOnce("treeref\n")
      .mockReturnValueOnce("commitref\n")
      .mockReturnValueOnce("");

    createCheckpoint("sess-1", "turn-1", "start", "/repo", "test");

    // Check that commit-tree call includes checkpoint ID in message
    const commitTreeCall = mockExecSync.mock.calls[2][0];
    expect(commitTreeCall).toContain("checkpoint:session-sess-1-turn-turn-1-start");
  });

  it("skips checkpoint during merge (status 128)", () => {
    const mergeError: any = new Error("merge in progress");
    mergeError.status = 128;
    mockExecSync.mockImplementation(() => {
      throw mergeError;
    });

    // Should not throw
    expect(() =>
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).not.toThrow();
  });

  it("skips checkpoint when merge message is present", () => {
    const mergeError = new Error("fatal: merge in progress");
    mockExecSync.mockImplementation(() => {
      throw mergeError;
    });

    expect(() =>
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).not.toThrow();
  });

  it("logs error for non-merge failures", () => {
    const error = new Error("permission denied");
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    // Should not throw, just log
    expect(() =>
      createCheckpoint("sess-1", "turn-1", "start", "/repo", "test")
    ).not.toThrow();
  });
});
