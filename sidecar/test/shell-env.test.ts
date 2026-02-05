import { describe, it, expect, vi, beforeEach } from "vitest";

// Must mock child_process before importing the module under test
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  execSync: mockExecSync,
}));

describe("getShellEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module to clear the cached shellEnvironment
    vi.resetModules();
  });

  async function importFresh() {
    return import("../agents/shell-env");
  }

  it("parses environment variables from shell output", async () => {
    mockExecSync.mockReturnValue(
      "some startup output\n_SHELL_ENV_DELIMITER_PATH=/usr/bin:/usr/local/bin\nHOME=/home/test\n_SHELL_ENV_DELIMITER_\n"
    );

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(env.PATH).toBe("/usr/bin:/usr/local/bin");
    expect(env.HOME).toBe("/home/test");
  });

  it("strips ANTHROPIC_API_KEY from environment", async () => {
    mockExecSync.mockReturnValue(
      "_SHELL_ENV_DELIMITER_ANTHROPIC_API_KEY=sk-123\nPATH=/usr/bin\n_SHELL_ENV_DELIMITER_"
    );

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips OPENAI_API_KEY from environment", async () => {
    mockExecSync.mockReturnValue(
      "_SHELL_ENV_DELIMITER_OPENAI_API_KEY=sk-456\nPATH=/usr/bin\n_SHELL_ENV_DELIMITER_"
    );

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("strips CLAUDE_CODE_USE_BEDROCK from environment", async () => {
    mockExecSync.mockReturnValue(
      "_SHELL_ENV_DELIMITER_CLAUDE_CODE_USE_BEDROCK=1\nPATH=/usr/bin\n_SHELL_ENV_DELIMITER_"
    );

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it("strips CLAUDE_CODE_USE_VERTEX from environment", async () => {
    mockExecSync.mockReturnValue(
      "_SHELL_ENV_DELIMITER_CLAUDE_CODE_USE_VERTEX=1\nPATH=/usr/bin\n_SHELL_ENV_DELIMITER_"
    );

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
  });

  it("caches the result after first call", async () => {
    mockExecSync.mockReturnValue(
      "_SHELL_ENV_DELIMITER_PATH=/usr/bin\n_SHELL_ENV_DELIMITER_"
    );

    const { getShellEnvironment } = await importFresh();

    const first = getShellEnvironment();
    const second = getShellEnvironment();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(first).toBe(second); // Same reference
  });

  it("handles empty environment section", async () => {
    mockExecSync.mockReturnValue("_SHELL_ENV_DELIMITER__SHELL_ENV_DELIMITER_");

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(Object.keys(env).length).toBe(0);
  });

  it("handles missing delimiter (returns empty object)", async () => {
    mockExecSync.mockReturnValue("no delimiters here");

    const { getShellEnvironment } = await importFresh();
    const env = getShellEnvironment();

    expect(Object.keys(env).length).toBe(0);
  });

  it("uses SHELL env var or falls back to /bin/zsh", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/bash";

    mockExecSync.mockReturnValue("_SHELL_ENV_DELIMITER_PATH=/usr/bin\n_SHELL_ENV_DELIMITER_");

    const { getShellEnvironment } = await importFresh();
    getShellEnvironment();

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("/bin/bash"),
      expect.any(Object)
    );

    process.env.SHELL = originalShell;
  });
});
