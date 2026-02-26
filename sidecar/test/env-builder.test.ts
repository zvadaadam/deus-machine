import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shell-env before importing
const { mockGetShellEnvironment } = vi.hoisted(() => ({
  mockGetShellEnvironment: vi.fn(() => ({ PATH: "/usr/bin", HOME: "/home/test" })),
}));

vi.mock("../agents/shell-env", () => ({
  getShellEnvironment: mockGetShellEnvironment,
}));

import { parseEnvString, buildAgentEnvironment } from "../agents/env-builder";

// ============================================================================
// parseEnvString
// ============================================================================

describe("parseEnvString", () => {
  it("parses simple KEY=value pairs", () => {
    const result = parseEnvString("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles export prefix", () => {
    const result = parseEnvString("export FOO=bar\nexport BAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comment lines", () => {
    const result = parseEnvString("# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores empty lines", () => {
    const result = parseEnvString("\nFOO=bar\n\n\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles double-quoted values", () => {
    const result = parseEnvString('FOO="hello world"');
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles single-quoted values", () => {
    const result = parseEnvString("FOO='hello world'");
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles multi-line quoted values", () => {
    const result = parseEnvString('FOO="line1\nline2"');
    expect(result).toEqual({ FOO: "line1\nline2" });
  });

  it("skips lines without equals sign", () => {
    const result = parseEnvString("FOO=bar\nINVALID_LINE\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles values with equals signs", () => {
    const result = parseEnvString("FOO=bar=baz=qux");
    expect(result).toEqual({ FOO: "bar=baz=qux" });
  });

  it("handles empty values", () => {
    const result = parseEnvString("FOO=");
    expect(result).toEqual({ FOO: "" });
  });

  it("handles empty input", () => {
    const result = parseEnvString("");
    expect(result).toEqual({});
  });

  it("trims whitespace from keys and values", () => {
    const result = parseEnvString("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
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

  it("opendevsEnv overrides extraEnv", () => {
    const env = buildAgentEnvironment({
      extraEnv: { MY_KEY: "extra" },
      opendevsEnv: { MY_KEY: "opendevs" },
    });
    expect(env.MY_KEY).toBe("opendevs");
  });

  it("claudeEnvVars overrides opendevsEnv", () => {
    const env = buildAgentEnvironment({
      opendevsEnv: { MY_KEY: "opendevs" },
      claudeEnvVars: "MY_KEY=from-user",
    });
    expect(env.MY_KEY).toBe("from-user");
  });

  it("claudeEnvVars with empty value deletes key", () => {
    const env = buildAgentEnvironment({
      extraEnv: { DELETE_ME: "exists" },
      claudeEnvVars: "DELETE_ME=",
    });
    expect(env.DELETE_ME).toBeUndefined();
  });

  it("ghToken sets GH_TOKEN as final layer", () => {
    const env = buildAgentEnvironment({
      claudeEnvVars: "GH_TOKEN=from-env-string",
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
      opendevsEnv: { WORKSPACE: "/my/project" },
      claudeEnvVars: "CUSTOM=value\nANOTHER=123",
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
