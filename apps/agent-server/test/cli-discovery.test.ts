import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();
const mockSendError = vi.fn();
const mockEmitSessionError = vi.fn();
const mockResolveBundledCliPath = vi.fn();
const mockGetBundledCliPathCandidates = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  };
});

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: {
    sendError: (...args: unknown[]) => mockSendError(...args),
    emitSessionError: (...args: unknown[]) => mockEmitSessionError(...args),
  },
}));

vi.mock("@shared/lib/cli-path", () => ({
  resolveBundledCliPath: (...args: unknown[]) => mockResolveBundledCliPath(...args),
  getBundledCliPathCandidates: (...args: unknown[]) => mockGetBundledCliPathCandidates(...args),
}));

import {
  discoverExecutable,
  blockIfNotInitialized,
  type DiscoveryConfig,
  type DiscoveryState,
} from "../agents/environment/cli-discovery";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<DiscoveryConfig>): DiscoveryConfig {
  return {
    agentHarness: "claude",
    displayName: "TestCLI",
    envVars: ["TEST_CLI_PATH"],
    bundledTool: "claude",
    versionFlag: "-v",
    ...overrides,
  };
}

function makeState(): DiscoveryState {
  return { executablePath: "", result: null };
}

function runDiscovery(configOverrides?: Partial<DiscoveryConfig>) {
  const config = makeConfig(configOverrides);
  const state = makeState();
  return { config, state, result: discoverExecutable(config, state) };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("discoverExecutable", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    mockSendError.mockReset();
    mockEmitSessionError.mockReset();
    mockResolveBundledCliPath.mockReset();
    mockGetBundledCliPathCandidates.mockReset();
    mockResolveBundledCliPath.mockReturnValue(null);
    mockGetBundledCliPathCandidates.mockReturnValue([]);
    mockStatSync.mockReturnValue({ isFile: () => true, mode: 0o755 });
    // Reset env to avoid leaking between tests
    delete process.env.TEST_CLI_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts the bundled runtime candidate without executing it", () => {
    mockExistsSync.mockReturnValue(true);

    mockResolveBundledCliPath.mockReturnValue("/usr/bin/testcli");
    const { result, state } = runDiscovery();

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/usr/bin/testcli");
    expect(state.result).toEqual({ success: true, path: "/usr/bin/testcli" });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("emits bundled CLI path on stdout in runtime mode", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.DEUS_RUNTIME = "1";
    mockExistsSync.mockReturnValue(true);
    mockResolveBundledCliPath.mockReturnValue("/runtime/bin/codex");

    runDiscovery({ bundledTool: "codex" });

    expect(stdoutWrite).toHaveBeenCalledWith("BUNDLED_CLI_PATH codex=/runtime/bin/codex\n");
    stdoutWrite.mockRestore();
  });

  it("tries the bundled candidate when an override fails verification", () => {
    mockExistsSync
      .mockReturnValueOnce(true) // /bad/path exists
      .mockReturnValueOnce(true); // /good/path exists
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("version check failed");
      })
      .mockReturnValueOnce("2.0.0");

    process.env.TEST_CLI_PATH = "/bad/path";
    mockResolveBundledCliPath.mockReturnValue("/good/path");
    const { result, state } = runDiscovery();

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/good/path");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("tries the bundled candidate when version validation rejects the override", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValueOnce("0.1.0");
    process.env.TEST_CLI_PATH = "/old/path";
    mockResolveBundledCliPath.mockReturnValue("/new/path");

    const { result, state } = runDiscovery({
      validateVersion: (versionOutput) =>
        versionOutput === "2.0.0"
          ? { success: true }
          : { success: false, error: `unsupported ${versionOutput}` },
    });

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/new/path");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns error when all candidates fail", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    process.env.TEST_CLI_PATH = "/missing/a";
    mockResolveBundledCliPath.mockReturnValue("/missing/b");

    const { result, state } = runDiscovery();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to initialize TestCLI executable");
    expect(result.error).toContain("/missing/a");
    expect(result.error).toContain("/missing/b");
    expect(state.result?.success).toBe(false);
  });

  it("skips path-like candidates that don't exist on disk", () => {
    mockExistsSync.mockReturnValue(false);
    mockResolveBundledCliPath.mockReturnValue("/nonexistent/cli");

    const { result } = runDiscovery();

    expect(result.success).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("uses env var override with highest priority", () => {
    process.env.TEST_CLI_PATH = "/env/override/cli";
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValueOnce("3.0.0");
    mockResolveBundledCliPath.mockReturnValue("/static/cli");

    const { result, state } = runDiscovery();

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/env/override/cli");
  });

  it("does not use shell discovery", () => {
    process.env.DEUS_PACKAGED = "1";
    mockExistsSync.mockReturnValue(false);
    mockResolveBundledCliPath.mockReturnValue(null);
    mockGetBundledCliPathCandidates.mockReturnValue(["/missing/cli"]);

    const { result } = runDiscovery();

    expect(result.success).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("uses bundled runtime candidate after env overrides", () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveBundledCliPath.mockReturnValue("/extra/path");

    const { result, state } = runDiscovery();

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/extra/path");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects bundled runtime candidates that are not executable files", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => true, mode: 0o644 });
    mockResolveBundledCliPath.mockReturnValue("/extra/path");

    const { result } = runDiscovery();

    expect(result.success).toBe(false);
    expect(result.error).toContain("/extra/path (not executable)");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects bare command names as custom overrides", () => {
    process.env.TEST_CLI_PATH = "testcli";
    mockExistsSync.mockReturnValue(true);

    const { result } = runDiscovery();

    expect(result.success).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(result.error).toContain("custom overrides must be executable paths");
  });

  it("rejects .js candidates", () => {
    process.env.TEST_CLI_PATH = "/usr/lib/cli.js";
    mockExistsSync.mockReturnValue(true);

    const { result } = runDiscovery();

    expect(result.success).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(result.error).toContain("JavaScript CLI wrappers are not supported");
  });

  it("uses execFileSync with candidate directly for native binaries", () => {
    process.env.TEST_CLI_PATH = "/usr/bin/testcli";
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValueOnce("7.0.0");

    runDiscovery();

    // Native binary: candidate is the executable, versionFlag in args array
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/testcli",
      ["-v"],
      expect.objectContaining({ encoding: "utf-8", timeout: 20000 })
    );
  });

  it("deduplicates env and bundled candidates", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("verify failed");
    });
    process.env.TEST_CLI_PATH = "/usr/bin/cli";
    mockResolveBundledCliPath.mockReturnValue("/usr/bin/cli");

    runDiscovery();

    // Should only try to verify /usr/bin/cli once (not twice for the duplicate)
    const verifyCalls = mockExecFileSync.mock.calls.filter(
      (call) => call[0] === "/usr/bin/cli" || (call[1] as string[])?.includes("/usr/bin/cli")
    );
    expect(verifyCalls).toHaveLength(1);
  });
});

describe("blockIfNotInitialized", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true and emits session error when initialization failed", () => {
    const state: DiscoveryState = {
      executablePath: "",
      result: { success: false, error: "Not found" },
    };

    const blocked = blockIfNotInitialized(state, "claude", "session-1");

    expect(blocked).toBe(true);
    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      expect.stringContaining("Not found"),
      "internal"
    );
  });

  it("emits canonical session error event when blocked", () => {
    const state: DiscoveryState = {
      executablePath: "",
      result: { success: false, error: "Not found" },
    };

    blockIfNotInitialized(state, "claude", "session-1");

    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      expect.stringContaining("Not found"),
      "internal"
    );
  });

  it("returns true when result is null (never initialized)", () => {
    const state: DiscoveryState = { executablePath: "", result: null };

    const blocked = blockIfNotInitialized(state, "codex-sdk", "session-2");

    expect(blocked).toBe(true);
    expect(mockEmitSessionError).toHaveBeenCalled();
  });

  it("emits session error event even if first emit throws", () => {
    const state: DiscoveryState = {
      executablePath: "",
      result: { success: false, error: "Not found" },
    };

    // First emitSessionError call throws — second should still succeed
    mockEmitSessionError.mockImplementationOnce(() => {
      throw new Error("No tunnel attached");
    });

    const blocked = blockIfNotInitialized(state, "claude", "session-1");

    expect(blocked).toBe(true);
    // emitSessionError is called twice (wrapped in try/catch), so at least one succeeds
    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      expect.stringContaining("Not found"),
      "internal"
    );
  });

  it("returns false when initialization succeeded", () => {
    const state: DiscoveryState = {
      executablePath: "/usr/bin/cli",
      result: { success: true, path: "/usr/bin/cli" },
    };

    const blocked = blockIfNotInitialized(state, "claude", "session-3");

    expect(blocked).toBe(false);
    expect(mockEmitSessionError).not.toHaveBeenCalled();
  });
});
