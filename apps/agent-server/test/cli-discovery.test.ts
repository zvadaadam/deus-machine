import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockSendError = vi.fn();
const mockEmitSessionError = vi.fn();

vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return { ...original, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: {
    sendError: (...args: unknown[]) => mockSendError(...args),
    emitSessionError: (...args: unknown[]) => mockEmitSessionError(...args),
  },
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
    agentType: "claude",
    displayName: "TestCLI",
    envVar: "TEST_CLI_PATH",
    staticCandidates: [],
    shellCommand: "testcli",
    versionFlag: "-v",
    ...overrides,
  };
}

function makeState(): DiscoveryState {
  return { executablePath: "", result: null };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("discoverExecutable", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to avoid leaking between tests
    delete process.env.TEST_CLI_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("succeeds when the first static candidate verifies", () => {
    const config = makeConfig({ staticCandidates: ["/usr/bin/testcli"] });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    // Shell discovery uses execSync — fail it so we fall through to static candidates
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery failed");
    });
    // Verification uses execFileSync
    mockExecFileSync.mockReturnValueOnce("1.0.0");

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/usr/bin/testcli");
    expect(state.result).toEqual({ success: true, path: "/usr/bin/testcli" });
  });

  it("tries the next candidate when the first fails verification", () => {
    const config = makeConfig({
      staticCandidates: ["/bad/path", "/good/path"],
    });
    const state = makeState();

    mockExistsSync
      .mockReturnValueOnce(true) // /bad/path exists
      .mockReturnValueOnce(true); // /good/path exists

    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery failed");
    });
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("version check failed");
      }) // /bad/path
      .mockReturnValueOnce("2.0.0"); // /good/path

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/good/path");
  });

  it("returns error when all candidates fail", () => {
    const config = makeConfig({
      staticCandidates: ["/missing/a", "/missing/b"],
    });
    const state = makeState();

    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to find TestCLI executable");
    expect(result.error).toContain("/missing/a");
    expect(result.error).toContain("/missing/b");
    expect(state.result?.success).toBe(false);
  });

  it("skips path-like candidates that don't exist on disk", () => {
    const config = makeConfig({ staticCandidates: ["/nonexistent/cli"] });
    const state = makeState();

    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(false);
    // execFileSync should not be called for the missing candidate
    // (only shell discovery via execSync should fire)
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("uses env var override with highest priority", () => {
    process.env.TEST_CLI_PATH = "/env/override/cli";
    const config = makeConfig({ staticCandidates: ["/static/cli"] });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockReturnValueOnce("3.0.0"); // env override succeeds

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/env/override/cli");
  });

  it("invokes extraCandidates callback and uses results", () => {
    const extraFn = vi.fn().mockReturnValue(["/extra/path"]);
    const config = makeConfig({ extraCandidates: extraFn });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockReturnValueOnce("4.0.0");

    const result = discoverExecutable(config, state);

    expect(extraFn).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/extra/path");
  });

  it("continues when extraCandidates throws", () => {
    const config = makeConfig({
      staticCandidates: ["/fallback/cli"],
      extraCandidates: () => {
        throw new Error("resolve failed");
      },
    });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockReturnValueOnce("5.0.0");

    const result = discoverExecutable(config, state);

    expect(result.success).toBe(true);
    expect(state.executablePath).toBe("/fallback/cli");
  });

  it("uses execFileSync with node for .js candidates", () => {
    const config = makeConfig({
      staticCandidates: ["/usr/lib/cli.js"],
    });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockReturnValueOnce("6.0.0");

    discoverExecutable(config, state);

    // Verification uses execFileSync with "node" as first arg and path in args array
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "node",
      ["/usr/lib/cli.js", "-v"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 })
    );
  });

  it("uses execFileSync with candidate directly for native binaries", () => {
    const config = makeConfig({
      staticCandidates: ["/usr/bin/testcli"],
    });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockReturnValueOnce("7.0.0");

    discoverExecutable(config, state);

    // Native binary: candidate is the executable, versionFlag in args array
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/testcli",
      ["-v"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 })
    );
  });

  it("deduplicates candidates from extraCandidates", () => {
    const config = makeConfig({
      staticCandidates: ["/usr/bin/cli"],
      extraCandidates: () => ["/usr/bin/cli"], // duplicate
    });
    const state = makeState();

    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("shell discovery");
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("verify failed");
    });

    discoverExecutable(config, state);

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

    const blocked = blockIfNotInitialized(state, "codex", "session-2");

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
