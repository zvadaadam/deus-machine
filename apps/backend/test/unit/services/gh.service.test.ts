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
  it("contains FAILURE", () => {
    expect(FAILING_CONCLUSIONS.has("FAILURE")).toBe(true);
  });

  it("contains ERROR", () => {
    expect(FAILING_CONCLUSIONS.has("ERROR")).toBe(true);
  });

  it("contains TIMED_OUT", () => {
    expect(FAILING_CONCLUSIONS.has("TIMED_OUT")).toBe(true);
  });

  it("contains STARTUP_FAILURE", () => {
    expect(FAILING_CONCLUSIONS.has("STARTUP_FAILURE")).toBe(true);
  });

  it("contains ACTION_REQUIRED", () => {
    expect(FAILING_CONCLUSIONS.has("ACTION_REQUIRED")).toBe(true);
  });

  it("contains CANCELLED", () => {
    expect(FAILING_CONCLUSIONS.has("CANCELLED")).toBe(true);
  });

  it("does not contain SUCCESS", () => {
    expect(FAILING_CONCLUSIONS.has("SUCCESS")).toBe(false);
  });

  it("does not contain NEUTRAL (intentionally non-blocking)", () => {
    expect(FAILING_CONCLUSIONS.has("NEUTRAL")).toBe(false);
  });

  it("does not contain SKIPPED (intentionally non-blocking)", () => {
    expect(FAILING_CONCLUSIONS.has("SKIPPED")).toBe(false);
  });
});

describe("PENDING_STATUSES", () => {
  it("contains PENDING", () => {
    expect(PENDING_STATUSES.has("PENDING")).toBe(true);
  });

  it("contains QUEUED", () => {
    expect(PENDING_STATUSES.has("QUEUED")).toBe(true);
  });

  it("contains IN_PROGRESS", () => {
    expect(PENDING_STATUSES.has("IN_PROGRESS")).toBe(true);
  });

  it("contains WAITING", () => {
    expect(PENDING_STATUSES.has("WAITING")).toBe(true);
  });

  it("contains REQUESTED", () => {
    expect(PENDING_STATUSES.has("REQUESTED")).toBe(true);
  });

  it("does not contain COMPLETED", () => {
    expect(PENDING_STATUSES.has("COMPLETED")).toBe(false);
  });
});

// ─── classifyCheck ────────────────────────────────────────────────

describe("classifyCheck", () => {
  describe("CheckRun (default __typename)", () => {
    it("returns failing for conclusion FAILURE", () => {
      expect(classifyCheck({ conclusion: "FAILURE" })).toBe("failing");
    });

    it("returns failing for conclusion TIMED_OUT", () => {
      expect(classifyCheck({ conclusion: "TIMED_OUT" })).toBe("failing");
    });

    it("returns failing for conclusion CANCELLED", () => {
      expect(classifyCheck({ conclusion: "CANCELLED" })).toBe("failing");
    });

    it("returns pending for conclusion null (still running)", () => {
      expect(classifyCheck({ conclusion: null })).toBe("pending");
    });

    it("returns pending for conclusion STALE", () => {
      expect(classifyCheck({ conclusion: "STALE" })).toBe("pending");
    });

    it("returns pending for status IN_PROGRESS", () => {
      expect(classifyCheck({ status: "IN_PROGRESS" })).toBe("pending");
    });

    it("returns pending for status QUEUED", () => {
      expect(classifyCheck({ status: "QUEUED" })).toBe("pending");
    });

    it("returns passing for conclusion SUCCESS", () => {
      expect(classifyCheck({ conclusion: "SUCCESS" })).toBe("passing");
    });

    it("returns passing for conclusion NEUTRAL (intentionally non-blocking)", () => {
      expect(classifyCheck({ conclusion: "NEUTRAL" })).toBe("passing");
    });

    it("returns passing for conclusion SKIPPED (intentionally non-blocking)", () => {
      expect(classifyCheck({ conclusion: "SKIPPED" })).toBe("passing");
    });
  });

  describe('StatusContext (__typename: "StatusContext")', () => {
    it("returns failing for state FAILURE", () => {
      expect(classifyCheck({ __typename: "StatusContext", state: "FAILURE" })).toBe("failing");
    });

    it("returns failing for state ERROR", () => {
      expect(classifyCheck({ __typename: "StatusContext", state: "ERROR" })).toBe("failing");
    });

    it("returns pending for state PENDING", () => {
      expect(classifyCheck({ __typename: "StatusContext", state: "PENDING" })).toBe("pending");
    });

    it("returns pending for state EXPECTED", () => {
      expect(classifyCheck({ __typename: "StatusContext", state: "EXPECTED" })).toBe("pending");
    });

    it("returns passing for state SUCCESS", () => {
      expect(classifyCheck({ __typename: "StatusContext", state: "SUCCESS" })).toBe("passing");
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
