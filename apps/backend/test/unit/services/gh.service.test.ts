import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const { mockExecFileAsync, mockGetGitRemoteUrl } = vi.hoisted(() => {
  const mockExecFileAsync = vi.fn(() => Promise.resolve({ stdout: "", stderr: "" }));
  const mockGetGitRemoteUrl = vi.fn();
  return { mockExecFileAsync, mockGetGitRemoteUrl };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("../../../src/lib/git-remotes", () => ({
  getGitRemoteUrl: mockGetGitRemoteUrl,
}));

import {
  classifyCheck,
  getPrStatus,
  runGh,
  FAILING_CONCLUSIONS,
  PENDING_STATUSES,
} from "../../../src/services/gh.service";

const originalBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntimeExecutable = process.env.DEUS_RUNTIME_EXECUTABLE;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const originalNodePath = process.env.NODE_PATH;

beforeEach(() => {
  vi.clearAllMocks();
  // Force resolveBundledCliPath to a non-existent dir so it returns null even
  // when a dev machine has staged binaries at process.cwd()/dist/runtime/...
  process.env.DEUS_BUNDLED_BIN_DIR = "/nonexistent/deus-test-bundled-bin";
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  mockGetGitRemoteUrl.mockImplementation(async (_workspacePath: string, remote: string) => {
    if (remote === "origin") return "https://github.com/expo/echo-backend.git";
    return null;
  });
});

afterAll(() => {
  if (originalBundledBinDir === undefined) delete process.env.DEUS_BUNDLED_BIN_DIR;
  else process.env.DEUS_BUNDLED_BIN_DIR = originalBundledBinDir;
  if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
  else process.env.DEUS_PACKAGED = originalDeusPackaged;
  if (originalDeusRuntimeExecutable === undefined) delete process.env.DEUS_RUNTIME_EXECUTABLE;
  else process.env.DEUS_RUNTIME_EXECUTABLE = originalDeusRuntimeExecutable;
  if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
});

// ─── Constants ────────────────────────────────────────────────────

describe("FAILING_CONCLUSIONS", () => {
  it.each(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"])(
    "contains %s",
    (conclusion) => {
      expect(FAILING_CONCLUSIONS.has(conclusion)).toBe(true);
    }
  );

  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])("does not contain %s", (conclusion) => {
    expect(FAILING_CONCLUSIONS.has(conclusion)).toBe(false);
  });
});

describe("PENDING_STATUSES", () => {
  it.each(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"])("contains %s", (status) => {
    expect(PENDING_STATUSES.has(status)).toBe(true);
  });

  it("does not contain COMPLETED", () => {
    expect(PENDING_STATUSES.has("COMPLETED")).toBe(false);
  });
});

// ─── classifyCheck ────────────────────────────────────────────────

describe("classifyCheck", () => {
  describe("CheckRun (default __typename)", () => {
    it.each([
      ["FAILURE", "failing"],
      ["TIMED_OUT", "failing"],
      ["CANCELLED", "failing"],
    ] as const)("returns failing for conclusion %s", (conclusion, expected) => {
      expect(classifyCheck({ conclusion })).toBe(expected);
    });

    it.each([
      ["null (still running)", null],
      ["STALE", "STALE"],
    ] as const)("returns pending for conclusion %s", (_label, conclusion) => {
      expect(classifyCheck({ conclusion })).toBe("pending");
    });

    it.each(["IN_PROGRESS", "QUEUED"])("returns pending for status %s", (status) => {
      expect(classifyCheck({ status })).toBe("pending");
    });

    it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])(
      "returns passing for conclusion %s",
      (conclusion) => {
        expect(classifyCheck({ conclusion })).toBe("passing");
      }
    );
  });

  describe('StatusContext (__typename: "StatusContext")', () => {
    it.each([
      ["FAILURE", "failing"],
      ["ERROR", "failing"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
      ["SUCCESS", "passing"],
    ] as const)("state %s returns %s", (state, expected) => {
      expect(classifyCheck({ __typename: "StatusContext", state })).toBe(expected);
    });
  });
});

// ─── runGh ────────────────────────────────────────────────────────

describe("runGh", () => {
  it("returns trimmed stdout on success", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "  some output\n", stderr: "" });

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({ success: true, stdout: "some output" });
  });

  it("passes correct args to execFileAsync", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await runGh(["pr", "list", "--json", "number"], { cwd: "/workspace", timeoutMs: 10000 });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "gh",
      ["pr", "list", "--json", "number"],
      expect.objectContaining({
        cwd: "/workspace",
        encoding: "utf-8",
        timeout: 10000,
      })
    );
  });

  it("uses default 5000ms timeout when not specified", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "gh",
      ["pr", "list"],
      expect.objectContaining({ timeout: 5000 })
    );
  });

  it("sets GIT_TERMINAL_PROMPT=0 and GH_PROMPT_DISABLED=1 in env", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await runGh(["pr", "list"], { cwd: "/workspace" });

    const callEnv = mockExecFileAsync.mock.calls[0][2].env;
    expect(callEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(callEnv.GH_PROMPT_DISABLED).toBe("1");
    expect(callEnv.GH_NO_UPDATE_NOTIFIER).toBe("1");
  });

  it("scrubs runtime-only env from gh child process", async () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_RUNTIME_EXECUTABLE = "/tmp/stale-runtime";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_PATH = "/tmp/stale-node-modules";
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    try {
      await runGh(["pr", "list"], { cwd: "/workspace" });

      const callEnv = mockExecFileAsync.mock.calls[0][2].env;
      expect(callEnv.DEUS_PACKAGED).toBeUndefined();
      expect(callEnv.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
      expect(callEnv.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
      expect(callEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(callEnv.NODE_PATH).toBeUndefined();
    } finally {
      if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
      else process.env.DEUS_PACKAGED = originalDeusPackaged;
      if (originalDeusRuntimeExecutable === undefined) delete process.env.DEUS_RUNTIME_EXECUTABLE;
      else process.env.DEUS_RUNTIME_EXECUTABLE = originalDeusRuntimeExecutable;
      if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
      if (originalNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = originalNodePath;
    }
  });

  it("prefers the bundled gh executable when present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deus-gh-service-"));
    const bundledGhPath = path.join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    process.env.DEUS_BUNDLED_BIN_DIR = dir;
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    try {
      writeFileSync(bundledGhPath, "");
      chmodSync(bundledGhPath, 0o755);

      await runGh(["pr", "list"], { cwd: "/workspace" });

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        bundledGhPath,
        ["pr", "list"],
        expect.any(Object)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves inherited PATH without adding global install fallbacks", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    try {
      await runGh(["pr", "list"], { cwd: "/workspace" });

      const callEnv = mockExecFileAsync.mock.calls[0][2].env;
      expect(callEnv.PATH).toBe("/nonexistent/deus-test-bundled-bin:/usr/bin:/bin");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("uses only bundled and system PATH entries in packaged runtime mode", async () => {
    const originalPath = process.env.PATH;
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    try {
      await runGh(["pr", "list"], { cwd: "/workspace" });

      const callEnv = mockExecFileAsync.mock.calls[0][2].env;
      expect(mockExecFileAsync.mock.calls[0][0]).toBe(
        "/Applications/Deus.app/Contents/Resources/bin/gh"
      );
      expect(callEnv.PATH).toBe(
        "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.DEUS_PACKAGED;
    }
  });

  it("returns gh_not_installed when ENOENT", async () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
      killed: false,
      stderr: "",
      stdout: "",
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "gh_not_installed",
      message: "GitHub CLI (gh) is not installed",
    });
  });

  it("returns timeout when process is killed", async () => {
    const err = Object.assign(new Error("killed"), {
      killed: true,
      code: null,
      stderr: "",
      stdout: "",
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "timeout",
      message: "GitHub CLI command timed out",
    });
  });

  it('returns gh_not_authenticated when stderr contains "gh auth login"', async () => {
    const err = Object.assign(new Error("auth required"), {
      killed: false,
      code: 1,
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
      stdout: "",
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "gh_not_authenticated",
      message: "GitHub CLI is not authenticated",
    });
  });

  it('returns gh_not_authenticated when output contains "not logged into any github hosts"', async () => {
    const err = Object.assign(new Error("not logged in"), {
      killed: false,
      code: 1,
      stderr: "",
      stdout: "not logged into any github hosts",
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "gh_not_authenticated",
      message: "GitHub CLI is not authenticated",
    });
  });

  it("returns unknown error for other exec failures", async () => {
    const err = Object.assign(new Error("something went wrong"), {
      killed: false,
      code: 1,
      stderr: "fatal: repository not found",
      stdout: "",
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "unknown",
      message: "fatal: repository not found",
    });
  });

  it("returns unknown error for non-exec errors", async () => {
    mockExecFileAsync.mockRejectedValue(new TypeError("unexpected"));

    const result = await runGh(["pr", "list"], { cwd: "/workspace" });

    expect(result).toEqual({
      success: false,
      error: "unknown",
      message: "unexpected",
    });
  });
});

// ─── getPrStatus ─────────────────────────────────────────────────

describe("getPrStatus", () => {
  it("looks up the PR by workspace branch without author filtering", async () => {
    const pr = {
      number: 720,
      title: "feat(web): unify iOS popover styling",
      url: "https://github.com/expo/echo-backend/pull/720",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
      reviewDecision: null,
      isDraft: false,
    };
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "adam-zvada/fe/popup-consistency\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([pr]), stderr: "" });

    const result = await getPrStatus("/workspace");

    expect(result).toMatchObject({
      has_pr: true,
      pr_number: 720,
      pr_url: "https://github.com/expo/echo-backend/pull/720",
      pr_state: "open",
    });
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "gh",
      expect.arrayContaining(["--head", "adam-zvada/fe/popup-consistency"]),
      expect.any(Object)
    );
    expect(mockExecFileAsync.mock.calls[1][1]).not.toContain("--author");
  });
});
