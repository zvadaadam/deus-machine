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

import { buildAgentEnvironment } from "../agents/environment";

const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntime = process.env.DEUS_RUNTIME;

describe("buildAgentEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
    else process.env.DEUS_PACKAGED = originalDeusPackaged;
    if (originalDeusRuntime === undefined) delete process.env.DEUS_RUNTIME;
    else process.env.DEUS_RUNTIME = originalDeusRuntime;
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

  it("skips login-shell environment capture in packaged runtime mode", () => {
    process.env.DEUS_RUNTIME = "1";
    mockGetShellEnvironment.mockReturnValue({ SHELL_ONLY_VAR: "from-shell" });

    const env = buildAgentEnvironment();

    expect(mockGetShellEnvironment).not.toHaveBeenCalled();
    expect(env.SHELL_ONLY_VAR).toBeUndefined();
  });

  it("skips login-shell environment capture in packaged app mode", () => {
    process.env.DEUS_PACKAGED = "1";
    mockGetShellEnvironment.mockReturnValue({ SHELL_PATH: "/opt/homebrew/bin:/usr/local/bin" });

    const env = buildAgentEnvironment();

    expect(mockGetShellEnvironment).not.toHaveBeenCalled();
    expect(env.SHELL_PATH).toBeUndefined();
  });

  it("extraEnv overrides process.env", () => {
    const env = buildAgentEnvironment({
      extraEnv: { PATH: "/custom/path" },
    });
    expect(env.PATH).toBe("/custom/path");
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
});
