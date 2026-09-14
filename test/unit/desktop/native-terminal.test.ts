import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNativeHandlers } from "../../../apps/desktop/main/native-handlers";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<string>>(),
  execute: vi.fn(),
  copy: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<string>) =>
      mocks.handlers.set(name, handler),
  },
  clipboard: { writeText: mocks.copy },
  dialog: {},
  nativeTheme: {},
  BrowserWindow: {},
  shell: {},
  Menu: {},
  app: {},
}));
vi.mock("child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute }),
}));
vi.mock("../../../apps/desktop/main/terminal-command", () => ({
  resolveTerminalCliCommand: mocks.resolve,
  toAppleScriptString: (value: string) => JSON.stringify(value),
}));
vi.mock("../../../apps/desktop/main/cli-tools", () => ({ checkCliTool: vi.fn() }));
vi.mock("../../../apps/desktop/main/github-cli-auth", () => ({
  logoutGhAuth: vi.fn(),
  startGhAuthLogin: vi.fn(),
}));

const originalPlatform = process.platform;
const command = "'/installed app/bin/claude' 'auth' 'login'";
const invoke = () =>
  mocks.handlers.get("native:openTerminal")!(null, { command: "claude auth login" });
const platform = (value: string) =>
  Object.defineProperty(process, "platform", { configurable: true, value });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.resolve.mockReturnValue(command);
  mocks.execute.mockResolvedValue({ stdout: "", stderr: "" });
  platform("darwin");
  registerNativeHandlers();
});
afterEach(() => platform(originalPlatform));

describe("native provider sign-in", () => {
  it("opens the resolved command on macOS", async () => {
    await expect(invoke()).resolves.toBe("opened");
    expect(mocks.execute).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining([
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      ])
    );
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("reports an asynchronous launcher failure", async () => {
    mocks.execute.mockRejectedValue(new Error("Terminal launch blocked"));
    await expect(invoke()).rejects.toThrow("Terminal launch blocked");
  });

  it("copies the bundled path on Linux without invoking a macOS launcher", async () => {
    platform("linux");
    await expect(invoke()).resolves.toBe("copied");
    expect(mocks.copy).toHaveBeenCalledWith(command);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("surfaces a missing bundled command rather than reporting success", async () => {
    mocks.resolve.mockReturnValue(null);
    await expect(invoke()).rejects.toThrow("unavailable in this installation");
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
