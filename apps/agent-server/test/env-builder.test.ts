import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shell-env before importing
const { mockGetShellEnvironment } = vi.hoisted(() => ({
  mockGetShellEnvironment: vi.fn(
    (): Record<string, string> => ({ PATH: "/usr/bin", HOME: "/home/test" })
  ),
}));

vi.mock("../agents/environment/shell-env", () => ({
  getShellEnvironment: mockGetShellEnvironment,
}));

import { parseEnvString, buildAgentEnvironment } from "../agents/environment";

// ============================================================================
// parseEnvString
// ============================================================================

describe("parseEnvString", () => {
  it.each([
    ["simple KEY=value pairs", "FOO=bar\nBAZ=qux", { FOO: "bar", BAZ: "qux" }],
    ["export prefix", "export FOO=bar\nexport BAZ=qux", { FOO: "bar", BAZ: "qux" }],
    [
      "comment lines (ignored)",
      "# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux",
      { FOO: "bar", BAZ: "qux" },
    ],
    ["empty lines (ignored)", "\nFOO=bar\n\n\nBAZ=qux\n", { FOO: "bar", BAZ: "qux" }],
    ["double-quoted values", 'FOO="hello world"', { FOO: "hello world" }],
    ["single-quoted values", "FOO='hello world'", { FOO: "hello world" }],
    ["multi-line quoted values", 'FOO="line1\nline2"', { FOO: "line1\nline2" }],
    [
      "lines without equals sign (skipped)",
      "FOO=bar\nINVALID_LINE\nBAZ=qux",
      { FOO: "bar", BAZ: "qux" },
    ],
    ["values with equals signs", "FOO=bar=baz=qux", { FOO: "bar=baz=qux" }],
    ["empty values", "FOO=", { FOO: "" }],
    ["empty input", "", {}],
    ["whitespace trimming", "  FOO  =  bar  ", { FOO: "bar" }],
  ] as const)("handles %s", (_label, input, expected) => {
    expect(parseEnvString(input as string)).toEqual(expected);
  });
});

// ============================================================================
// buildAgentEnvironment
// ============================================================================

describe("buildAgentEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetShellEnvironment.mockReturnValue({ PATH: "/usr/bin", HOME: "/home/test" });
  });

  it("includes shell environment as base layer", () => {
    mockGetShellEnvironment.mockReturnValue({ SHELL_ONLY_VAR: "from-shell" });
    const env = buildAgentEnvironment();
    // Shell vars that aren't in process.env survive intact
    expect(env.SHELL_ONLY_VAR).toBe("from-shell");
    expect(mockGetShellEnvironment).toHaveBeenCalled();
  });

  it("process.env overrides shell environment", () => {
    mockGetShellEnvironment.mockReturnValue({ MY_VAR: "from-shell" });
    const originalEnv = process.env.MY_VAR;
    process.env.MY_VAR = "from-process";
    try {
      const env = buildAgentEnvironment();
      expect(env.MY_VAR).toBe("from-process");
    } finally {
      if (originalEnv === undefined) delete process.env.MY_VAR;
      else process.env.MY_VAR = originalEnv;
    }
  });

  it("extraEnv overrides process.env", () => {
    const env = buildAgentEnvironment({
      extraEnv: { PATH: "/custom/path" },
    });
    expect(env.PATH).toBe("/custom/path");
  });

  it("deusEnv overrides extraEnv", () => {
    const env = buildAgentEnvironment({
      extraEnv: { MY_KEY: "extra" },
      deusEnv: { MY_KEY: "deus" },
    });
    expect(env.MY_KEY).toBe("deus");
  });

  it("providerEnvVars overrides deusEnv", () => {
    const env = buildAgentEnvironment({
      deusEnv: { MY_KEY: "deus" },
      providerEnvVars: "MY_KEY=from-user",
    });
    expect(env.MY_KEY).toBe("from-user");
  });

  it("providerEnvVars with empty value deletes key", () => {
    const env = buildAgentEnvironment({
      extraEnv: { DELETE_ME: "exists" },
      providerEnvVars: "DELETE_ME=",
    });
    expect(env.DELETE_ME).toBeUndefined();
  });

  it("ghToken sets GH_TOKEN as final layer", () => {
    const env = buildAgentEnvironment({
      providerEnvVars: "GH_TOKEN=from-env-string",
      ghToken: "from-option",
    });
    expect(env.GH_TOKEN).toBe("from-option");
  });

  it("works with no options", () => {
    const env = buildAgentEnvironment();
    expect(env).toBeDefined();
    expect(typeof env).toBe("object");
  });

  it("handles shell environment failure gracefully", () => {
    mockGetShellEnvironment.mockImplementation(() => {
      throw new Error("shell failed");
    });
    const env = buildAgentEnvironment({ extraEnv: { FALLBACK: "yes" } });
    expect(env.FALLBACK).toBe("yes");
  });

  it("applies multiple layers together", () => {
    const env = buildAgentEnvironment({
      extraEnv: { TASKS: "true", AGENT: "claude" },
      deusEnv: { WORKSPACE: "/my/project" },
      providerEnvVars: "CUSTOM=value\nANOTHER=123",
      ghToken: "gh-token-123",
    });
    expect(env.TASKS).toBe("true");
    expect(env.AGENT).toBe("claude");
    expect(env.WORKSPACE).toBe("/my/project");
    expect(env.CUSTOM).toBe("value");
    expect(env.ANOTHER).toBe("123");
    expect(env.GH_TOKEN).toBe("gh-token-123");
  });
});
