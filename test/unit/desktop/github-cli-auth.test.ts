import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockCheckCliTool, mockExecFileAsync, mockGetCliLookupEnv } = vi.hoisted(() => ({
  mockCheckCliTool: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockGetCliLookupEnv: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../../apps/desktop/main/cli-tools", () => ({
  checkCliTool: (...args: unknown[]) => mockCheckCliTool(...args),
  getCliLookupEnv: (...args: unknown[]) => mockGetCliLookupEnv(...args),
}));

import { logoutGhAuth, startGhAuthLogin } from "../../../apps/desktop/main/github-cli-auth";

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckCliTool.mockResolvedValue({
    installed: true,
    path: "/Applications/Deus.app/Contents/Resources/bin/gh",
  });
  mockGetCliLookupEnv.mockReturnValue({
    PATH: "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("desktop GitHub CLI auth", () => {
  it("starts auth login through the resolved bundled gh path", async () => {
    await expect(startGhAuthLogin()).resolves.toEqual({
      success: true,
      path: "/Applications/Deus.app/Contents/Resources/bin/gh",
    });

    expect(mockCheckCliTool).toHaveBeenCalledWith("gh");
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "/Applications/Deus.app/Contents/Resources/bin/gh",
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
        "--clipboard",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          GH_NO_UPDATE_NOTIFIER: "1",
        }),
        timeout: 10 * 60 * 1000,
      })
    );
  });

  it("does not try auth login when packaged gh is unavailable", async () => {
    mockCheckCliTool.mockResolvedValueOnce({ installed: false, path: null });

    await expect(startGhAuthLogin()).resolves.toEqual({
      success: false,
      path: null,
      error: "GitHub CLI not found",
    });

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("logs out through the resolved bundled gh path", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{ active: true, login: "deus-user", state: "success" }],
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(logoutGhAuth()).resolves.toEqual({
      success: true,
      path: "/Applications/Deus.app/Contents/Resources/bin/gh",
    });

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "/Applications/Deus.app/Contents/Resources/bin/gh",
      ["auth", "logout", "--hostname", "github.com", "--user", "deus-user"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        }),
        timeout: 15_000,
      })
    );
  });
});
