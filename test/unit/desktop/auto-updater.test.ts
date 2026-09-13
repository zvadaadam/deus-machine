import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), check: vi.fn(), install: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("electron-updater", () => ({
  autoUpdater: Object.assign(new EventEmitter(), {
    checkForUpdates: mocks.check,
    quitAndInstall: mocks.install,
  }),
}));

let updater: typeof import("electron-updater").autoUpdater;
let invoke: (channel: string) => unknown;
const send = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("APPIMAGE", "/fixture/Deus.AppImage");
  vi.clearAllMocks();
  mocks.check.mockResolvedValue({ isUpdateAvailable: false });
  updater = (await import("electron-updater")).autoUpdater;
  updater.removeAllListeners();
  const { setupAutoUpdater } = await import("../../../apps/desktop/main/auto-updater");
  setupAutoUpdater({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send },
  } as unknown as BrowserWindow);
  invoke = (channel) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]();
  await Promise.resolve();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("offers installation only after the download, and keeps its state across renderer reloads", async () => {
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
  expect(await invoke("update:check")).toEqual({ supported: true, available: false });
});

it("surfaces a failed background download and permits a new check", async () => {
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
  expect(invoke("update:getState")).toEqual({ stage: "error", error: "Download interrupted" });
  expect(send).toHaveBeenLastCalledWith("update:state", {
    stage: "error",
    error: "Download interrupted",
  });
  await invoke("update:check");
  expect(mocks.check).toHaveBeenCalledTimes(3);
});

it("rejects failed manual checks and registers only one polling loop", async () => {
  mocks.check.mockRejectedValueOnce(new Error("Offline"));
  await expect(invoke("update:check")).rejects.toThrow("Offline");
  expect(invoke("update:getState")).toEqual({ stage: "error", error: "Offline" });
  const { setupAutoUpdater } = await import("../../../apps/desktop/main/auto-updater");
  setupAutoUpdater({ isDestroyed: () => true } as unknown as BrowserWindow);
  expect(mocks.handle).toHaveBeenCalledTimes(3);
  mocks.check.mockClear();
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(mocks.check).toHaveBeenCalledTimes(1);
});

it("reports unsupported updates for an unpackaged Linux installation", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("APPIMAGE", undefined);
    expect(await invoke("update:check")).toMatchObject({ supported: false, available: false });
    updater.emit("update-downloaded", { version: "0.4.0" });
    invoke("update:install");
    expect(mocks.install).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
