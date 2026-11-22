import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  packaged: true,
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
  autoUpdater: new EventEmitter(),
  ipcMain: { handle: mocks.handle },
}));
vi.mock("electron-updater", () => ({
  autoUpdater: Object.assign(new EventEmitter(), {
    checkForUpdates: mocks.check,
    quitAndInstall: mocks.install,
  }),
}));

let updater: typeof import("electron-updater").autoUpdater;
let invoke: (channel: string) => unknown;
const send = vi.fn();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("APPIMAGE", "/fixture/Deus.AppImage");
  vi.clearAllMocks();
  mocks.packaged = true;
  mocks.check.mockResolvedValue({ isUpdateAvailable: false });
  const { autoUpdater: nativeAutoUpdater } = await import("electron");
  nativeAutoUpdater.removeAllListeners();
  updater = (await import("electron-updater")).autoUpdater;
  updater.removeAllListeners();
});

async function startUpdater() {
  const { registerUpdateHandlers, setupAutoUpdater } =
    await import("../../../apps/desktop/main/auto-updater");
  registerUpdateHandlers((quit) => quit());
  setupAutoUpdater({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send },
  } as unknown as BrowserWindow);
  invoke = (channel) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]();
  await Promise.resolve();
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
});

it("offers installation only after the download, and keeps its state across renderer reloads", async () => {
  await startUpdater();
  updater.emit("update-available", { version: "0.4.0" });
  expect(invoke("update:getState")).toEqual({ stage: "downloading", version: "0.4.0" });
  invoke("update:install");
  expect(mocks.install).not.toHaveBeenCalled();
  updater.emit("download-progress", { percent: 40 });
  expect(invoke("update:getState")).toMatchObject({ percent: 40 });
  updater.emit("update-downloaded", { version: "0.4.0", releaseNotes: "Changes" });
  expect(invoke("update:getState")).toEqual({
    stage: "ready",
    version: "0.4.0",
    releaseNotes: "Changes",
  });
  mocks.check.mockClear();
  expect(await invoke("update:check")).toEqual({ supported: true, available: true });
  expect(mocks.check).not.toHaveBeenCalled();
  invoke("update:install");
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith(false, true);
});

it("reports the SDK availability flag instead of the truthiness of its result", async () => {
  await startUpdater();
  expect(invoke("update:getState")).toEqual({ stage: "idle" });
  expect(await invoke("update:check")).toEqual({ supported: true, available: false });
});

it("retains the version when a staged AppImage cannot be installed", async () => {
  await startUpdater();
  updater.emit("update-downloaded", { version: "0.4.0" });
  mocks.install.mockImplementationOnce(() => {
    throw new Error("Install failed");
  });
  expect(() => invoke("update:install")).toThrow("Install failed");
  expect(invoke("update:getState")).toEqual({
    stage: "error",
    error: "Install failed",
    version: "0.4.0",
  });
});

it("surfaces a failed background download and permits a new check", async () => {
  await startUpdater();
  let rejectDownload!: (err: Error) => void;
  mocks.check.mockImplementationOnce(async () => {
    updater.emit("update-available", { version: "0.4.0" });
    return {
      isUpdateAvailable: true,
      downloadPromise: new Promise((_, reject) => {
        rejectDownload = reject;
      }),
    };
  });
  await invoke("update:check");
  rejectDownload(new Error("Download interrupted"));
  await Promise.resolve();
  const failed = { stage: "error", error: "Download interrupted" };
  expect(invoke("update:getState")).toEqual(failed);
  expect(send).toHaveBeenLastCalledWith("update:state", failed);
  await invoke("update:check");
  expect(mocks.check).toHaveBeenCalledTimes(3);
});

it("rejects failed manual checks and registers only one polling loop", async () => {
  await startUpdater();
  mocks.check.mockRejectedValueOnce(new Error("Offline"));
  await expect(invoke("update:check")).rejects.toThrow("Offline");
  expect(invoke("update:getState")).toEqual({ stage: "error", error: "Offline" });
  const { registerUpdateHandlers, setupAutoUpdater } =
    await import("../../../apps/desktop/main/auto-updater");
  registerUpdateHandlers((quit) => quit());
  setupAutoUpdater({ isDestroyed: () => true } as unknown as BrowserWindow);
  expect(mocks.handle).toHaveBeenCalledTimes(3);
  mocks.check.mockClear();
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(mocks.check).toHaveBeenCalledTimes(1);
});

it("reports why the Debian package cannot update from the first snapshot", async () => {
  vi.stubEnv("APPIMAGE", undefined);
  await startUpdater();
  const reason = "Linux auto-update requires the AppImage build.";
  expect(invoke("update:getState")).toEqual({ stage: "unsupported", reason });
  expect(await invoke("update:check")).toEqual({ supported: false, available: false, reason });
  updater.emit("update-downloaded", { version: "0.4.0" });
  invoke("update:install");
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
});

it("reports an unsupported development build before the window checks", async () => {
  mocks.packaged = false;
  await startUpdater();
  const state = {
    stage: "unsupported",
    reason: "Development builds do not download updates.",
  };
  expect(invoke("update:getState")).toEqual(state);
  expect(await invoke("update:check")).toMatchObject({ supported: false, reason: state.reason });
  expect(mocks.check).not.toHaveBeenCalled();
});
