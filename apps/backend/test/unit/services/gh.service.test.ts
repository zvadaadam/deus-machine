import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const { mockExecFileAsync } = vi.hoisted(() => {
  const mockExecFileAsync = vi.fn(() => Promise.resolve({ stdout: "", stderr: "" }));
  return { mockExecFileAsync };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  classifyCheck,
  runGh,
  FAILING_CONCLUSIONS,
  PENDING_STATUSES,
} from "../../../src/services/gh.service";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
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
