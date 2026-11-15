import { vi, describe, it, expect, beforeEach } from "vitest";

// Every git call is the callback `execFile` (git.service promisifies it). The
// synchronous forms are mocked too, only so a test can prove they are never used.
vi.mock("child_process", () => ({
  execFile: vi.fn<(...args: any[]) => any>(),
  execFileSync: vi.fn<(...args: any[]) => any>(),
  execSync: vi.fn<(...args: any[]) => any>(),
  spawnSync: vi.fn<(...args: any[]) => any>(),
}));

// Untracked files are read through fs/promises; the sync reads are watched the same way.
const fsMock = vi.hoisted(() => ({
  promises: {
    stat: vi.fn<(...args: any[]) => any>(),
    readFile: vi.fn<(...args: any[]) => any>(),
  },
  sync: {
    statSync: vi.fn<(...args: any[]) => any>(),
    readFileSync: vi.fn<(...args: any[]) => any>(),
  },
}));
vi.mock("fs/promises", () => ({ default: fsMock.promises, ...fsMock.promises }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const mocked = { ...actual, ...fsMock.sync };
  return { ...mocked, default: mocked };
});

import { execFile, execFileSync, execSync, spawnSync } from "child_process";
import {
  normalizeGitPath,
  splitGitDiffTokens,
  extractDiffInfo,
  resolveWorkspaceRelativePath,
  getDiffStats,
  getDiffFiles,
  getMergeBase,
  getGitFileContent,
  verifyBranchExists,
  detectDefaultBranch,
  resolveParentBranch,
} from "../../../src/services/git.service";

import {
  SIMPLE_MODIFY_DIFF,
  NEW_FILE_DIFF,
  DELETE_FILE_DIFF,
  RENAME_DIFF,
  QUOTED_PATH_DIFF,
  NUMSTAT_OUTPUT,
  SHORTSTAT_OUTPUT,
  SHORTSTAT_SINGLE,
} from "../../fixtures/git-diffs";

const mockExecFile = vi.mocked(execFile);

/**
 * What `git <args>` prints: return the output, or throw for a failing command.
 * The `execFile` mock hands it to git.service through the callback, as
 * `{ stdout, stderr }` the way promisify resolves it.
 */
const git = vi.fn<(cmd: string, args: readonly string[]) => unknown>();

function answerThroughExecFile() {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: readonly string[],
    _opts: unknown,
    done: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    let out: unknown;
    try {
      out = git(cmd, args ?? []);
    } catch (err) {
      done(err as Error);
      return;
    }
    done(null, { stdout: out === undefined ? "" : String(out), stderr: "" });
  }) as any);
}

describe("pure functions", () => {
  describe("normalizeGitPath", () => {
    it("strips a/ prefix", () => {
      expect(normalizeGitPath("a/src/app.ts")).toBe("src/app.ts");
    });

    it("strips b/ prefix", () => {
      expect(normalizeGitPath("b/src/app.ts")).toBe("src/app.ts");
    });

    it("strips surrounding quotes", () => {
      expect(normalizeGitPath('"a/path with spaces/file.ts"')).toBe("path with spaces/file.ts");
    });

    it("returns null for empty string", () => {
      expect(normalizeGitPath("")).toBeNull();
    });

    it("returns null for non-string input", () => {
      expect(normalizeGitPath(null as unknown as string)).toBeNull();
    });

    it("returns path unchanged when no prefix", () => {
      expect(normalizeGitPath("src/file.ts")).toBe("src/file.ts");
    });
  });

  describe("splitGitDiffTokens", () => {
    it("splits space-separated tokens", () => {
      expect(splitGitDiffTokens("a/file.ts b/file.ts")).toEqual(["a/file.ts", "b/file.ts"]);
    });

    it("handles quoted tokens", () => {
      expect(
        splitGitDiffTokens('"a/path with spaces/file.ts" "b/path with spaces/file.ts"')
      ).toEqual(["a/path with spaces/file.ts", "b/path with spaces/file.ts"]);
    });

    it("returns empty array for empty input", () => {
      expect(splitGitDiffTokens("")).toEqual([]);
    });

    it("limits to max 2 tokens", () => {
      const result = splitGitDiffTokens("a b c d");
      expect(result).toHaveLength(2);
    });
  });

  describe("extractDiffInfo", () => {
    it("parses a simple modify diff", () => {
      const info = extractDiffInfo(SIMPLE_MODIFY_DIFF);
      expect(info.oldPath).toBe("src/app.ts");
      expect(info.newPath).toBe("src/app.ts");
      expect(info.isNew).toBe(false);
      expect(info.isDeleted).toBe(false);
    });

    it("parses a new file diff", () => {
      const info = extractDiffInfo(NEW_FILE_DIFF);
      expect(info.newPath).toBe("src/new-file.ts");
      expect(info.isNew).toBe(true);
      expect(info.isDeleted).toBe(false);
    });

    it("parses a deleted file diff", () => {
      const info = extractDiffInfo(DELETE_FILE_DIFF);
      expect(info.oldPath).toBe("src/old-file.ts");
      expect(info.isDeleted).toBe(true);
    });

    it("parses a rename diff", () => {
      const info = extractDiffInfo(RENAME_DIFF);
      expect(info.oldPath).toBe("old-name.ts");
      expect(info.newPath).toBe("new-name.ts");
    });

    it("parses a diff with quoted paths", () => {
      const info = extractDiffInfo(QUOTED_PATH_DIFF);
      expect(info.oldPath).toBe("path with spaces/file.ts");
      expect(info.newPath).toBe("path with spaces/file.ts");
    });
  });

  describe("resolveWorkspaceRelativePath", () => {
    it("returns a safe relative path", () => {
      const result = resolveWorkspaceRelativePath("/workspace", "src/file.ts");
      expect(result).toBe("src/file.ts");
    });

    it("returns null for path traversal attempts", () => {
      const result = resolveWorkspaceRelativePath("/workspace", "../../etc/passwd");
      expect(result).toBeNull();
    });

    it("returns null for absolute paths", () => {
      const result = resolveWorkspaceRelativePath("/workspace", "/etc/passwd");
      expect(result).toBeNull();
    });

    it("returns null for null-byte injection", () => {
      const result = resolveWorkspaceRelativePath("/workspace", "file\0.ts");
      expect(result).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(resolveWorkspaceRelativePath("/workspace", "")).toBeNull();
    });

    it("returns null for non-string input", () => {
      expect(resolveWorkspaceRelativePath("/workspace", null as unknown as string)).toBeNull();
    });
  });
});

describe("exec-dependent functions", () => {
  beforeEach(() => {
    git.mockReset();
    mockExecFile.mockReset();
    answerThroughExecFile();
  });

  describe("getDiffStats", () => {
    it("parses shortstat output correctly", async () => {
      git.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs.includes("merge-base")) return "abc123\n";
        if (gitArgs.includes("--shortstat")) return SHORTSTAT_OUTPUT;
        if (gitArgs.includes("--others")) return "";
        return "";
      });
      const result = await getDiffStats("/workspace", "origin/main");
      expect(result).toEqual({ additions: 13, deletions: 20 });
    });

    it("returns zeros on error", async () => {
      git.mockImplementation(() => {
        throw new Error("git failed");
      });
      const result = await getDiffStats("/workspace", "origin/main");
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it("parses single insertion shortstat", async () => {
      git.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs.includes("merge-base")) return "abc123\n";
        if (gitArgs.includes("--shortstat")) return SHORTSTAT_SINGLE;
        if (gitArgs.includes("--others")) return "";
        return "";
      });
      const result = await getDiffStats("/workspace", "origin/main");
      expect(result).toEqual({ additions: 1, deletions: 0 });
    });
    it("never blocks the event loop: only async child processes and file reads", async () => {
      git.mockImplementation((_cmd: string, args: readonly string[]) => {
        if (args.includes("merge-base")) return "abc123\n";
        if (args.includes("--shortstat")) return SHORTSTAT_OUTPUT;
        if (args.includes("--others")) return "notes.txt\n";
        return "";
      });
      fsMock.promises.stat.mockResolvedValue({ size: 12 });
      fsMock.promises.readFile.mockResolvedValue(Buffer.from("one\ntwo\nthree"));

      const result = await getDiffStats("/workspace", "origin/main");

      // 13 insertions from shortstat + 3 lines of the untracked file
      expect(result).toEqual({ additions: 16, deletions: 20 });
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      expect(fsMock.promises.readFile).toHaveBeenCalledWith("/workspace/notes.txt");
      expect(execFileSync).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(fsMock.sync.statSync).not.toHaveBeenCalled();
      expect(fsMock.sync.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe("getDiffFiles", () => {
    it("parses numstat output into file array", async () => {
      git.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs.includes("merge-base")) return "abc123\n";
        if (gitArgs.includes("--numstat")) return NUMSTAT_OUTPUT;
        if (gitArgs.includes("--others")) return "";
        return "";
      });
      const result = await getDiffFiles("/workspace", "origin/main");
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ file: "src/app.ts", additions: 10, deletions: 5 });
      expect(result[1]).toEqual({ file: "src/new-file.ts", additions: 3, deletions: 0 });
      expect(result[2]).toEqual({ file: "src/old-file.ts", additions: 0, deletions: 15 });
    });

    it("returns empty array on error", async () => {
      git.mockImplementation(() => {
        throw new Error("git failed");
      });
      const result = await getDiffFiles("/workspace", "origin/main");
      expect(result).toEqual([]);
    });
  });

  describe("getMergeBase", () => {
    it("returns trimmed merge-base hash", async () => {
      git.mockReturnValue("abc123\n");
      const result = await getMergeBase("/workspace", "origin/main");
      expect(result).toBe("abc123");
    });

    it("returns HEAD as fallback on error", async () => {
      git.mockImplementation(() => {
        throw new Error("git failed");
      });
      const result = await getMergeBase("/workspace", "origin/main");
      expect(result).toBe("HEAD");
    });
  });

  describe("getGitFileContent", () => {
    it("returns file content on success", async () => {
      git.mockReturnValue("file content");
      const result = await getGitFileContent("/workspace", "HEAD", "src/app.ts");
      expect(result).toBe("file content");
    });

    it("returns null on error", async () => {
      git.mockImplementation(() => {
        throw new Error("git failed");
      });
      const result = await getGitFileContent("/workspace", "HEAD", "src/app.ts");
      expect(result).toBeNull();
    });

    it("returns null for empty filePath", async () => {
      const result = await getGitFileContent("/workspace", "HEAD", "");
      expect(result).toBeNull();
    });
  });

  describe("verifyBranchExists", () => {
    it("falls back through refs until one succeeds", async () => {
      // First 2 calls throw (refs/heads/feature, refs/remotes/origin/feature),
      // 3rd call succeeds (refs/heads/main)
      git
        .mockImplementationOnce(() => {
          throw new Error("not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("not found");
        })
        .mockImplementationOnce(() => "");
      const result = await verifyBranchExists("/workspace", "feature");
      expect(result).toBe("main");
    });

    it("returns the branch if first ref succeeds", async () => {
      git.mockReturnValue("");
      const result = await verifyBranchExists("/workspace", "develop");
      expect(result).toBe("develop");
    });

    it("returns main when all checks fail", async () => {
      git.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = await verifyBranchExists("/workspace", "nonexistent");
      expect(result).toBe("main");
    });
  });

  describe("detectDefaultBranch", () => {
    it("uses origin HEAD strategy and verifies branch", async () => {
      // First call: symbolic-ref returns origin/develop ref
      git.mockImplementation((_cmd: string, args: readonly string[] = []) => {
        if (args[0] === "symbolic-ref") {
          return "refs/remotes/origin/develop";
        }
        // verifyBranchExists: first check (refs/heads/develop) succeeds
        if (args[0] === "show-ref") {
          return "";
        }
        return "";
      });
      const result = await detectDefaultBranch("/workspace");
      expect(result).toBe("develop");
    });

    it("falls back to main when all strategies fail", async () => {
      // All exec calls throw
      git.mockImplementation(() => {
        throw new Error("failed");
      });
      const result = await detectDefaultBranch("/workspace");
      expect(result).toBe("main");
    });
  });

  describe("resolveParentBranch", () => {
    // origin/<target> exists for the refs listed; every other show-ref fails.
    const refsThatExist = (refs: string[]) =>
      git.mockImplementation((_cmd: string, args: readonly string[]) => {
        if (args[0] === "show-ref" && refs.includes(args[3])) return "";
        throw new Error("not found");
      });

    it("keeps its answer across several 5-second polls, and expires after 30s", async () => {
      vi.useFakeTimers();
      try {
        refsThatExist(["refs/remotes/origin/feature-a"]);
        expect(await resolveParentBranch("/ws-cache", "feature-a", "main")).toBe(
          "origin/feature-a"
        );
        const spawns = mockExecFile.mock.calls.length;

        vi.advanceTimersByTime(25_000);
        expect(await resolveParentBranch("/ws-cache", "feature-a", "main")).toBe(
          "origin/feature-a"
        );
        expect(mockExecFile.mock.calls.length).toBe(spawns);

        vi.advanceTimersByTime(6_000);
        refsThatExist(["refs/remotes/origin/main"]);
        expect(await resolveParentBranch("/ws-cache", "feature-a", "main")).toBe("origin/main");
      } finally {
        vi.useRealTimers();
      }
    });

    it("picks up a changed target branch at once", async () => {
      refsThatExist(["refs/remotes/origin/feature-a", "refs/remotes/origin/feature-b"]);
      expect(await resolveParentBranch("/ws-retarget", "feature-a", "main")).toBe(
        "origin/feature-a"
      );
      expect(await resolveParentBranch("/ws-retarget", "feature-b", "main")).toBe(
        "origin/feature-b"
      );
    });
  });
});
