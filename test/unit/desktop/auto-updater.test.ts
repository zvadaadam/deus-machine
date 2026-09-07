import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal EventEmitter stand-in for electron-updater's `autoUpdater`. Built
// without importing node:events (vi.hoisted runs before imports resolve, so an
// imported class would hit a TDZ). Mirrors just the surface this module uses:
// `.on`, `.emit`, `removeAllListeners`, plus the updater properties/methods.
const { autoUpdater, ipcMain, sentStates } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event: string, handler: (...args: unknown[]) => void) {
      const arr = listeners.get(event);
      if (arr) arr.push(handler);
      else listeners.set(event, [handler]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    removeAllListeners(event?: string) {
      if (event) listeners.delete(event);
      else listeners.clear();
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const arr = listeners.get(event);
      if (arr)
        listeners.set(
          event,
          arr.filter((h) => h !== handler)
        );
    },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  return {
    autoUpdater: updater,
    ipcMain: { handle: vi.fn() },
    sentStates: [] as Array<{ channel: string; state: unknown }>,
  };
});

vi.mock("electron", () => ({ ipcMain, BrowserWindow: {} }));
vi.mock("electron-updater", () => ({ autoUpdater }));

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_APPIMAGE = process.env.APPIMAGE;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function createMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, state: unknown) => sentStates.push({ channel, state }),
    },
  };
}

function readyStates(): Array<Record<string, unknown>> {
  return sentStates
    .filter((entry) => (entry.state as { stage?: string })?.stage === "ready")
    .map((entry) => entry.state as Record<string, unknown>);
}

// setupAutoUpdater is a once-per-process call (module-level `updaterStarted`
// guard), and `isAutoUpdateSupported()` returns false on Linux without
// APPIMAGE — so each test re-imports the module fresh (resetting the guard)
// and forces platform to darwin (always supported).
async function freshSetup(): Promise<{
  ipcHandlers: Map<string, (...args: unknown[]) => unknown>;
}> {
  autoUpdater.removeAllListeners();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdates.mockReset();
  autoUpdater.downloadUpdate.mockReset();
  autoUpdater.quitAndInstall.mockReset();
  // setupAutoUpdater fires an initial checkForUpdates() and a 4-hour interval
  // that both call .checkForUpdates(); default to a resolving promise so those
  // paths never throw.
  autoUpdater.checkForUpdates.mockResolvedValue(null);
  ipcMain.handle.mockClear();
  sentStates.length = 0;

  setPlatform("darwin");
  delete process.env.APPIMAGE;

  vi.resetModules();
  const mod = await import("../../../apps/desktop/main/auto-updater");
  mod.setupAutoUpdater(createMainWindow());

  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  for (const [channel, handler] of ipcMain.handle.mock.calls as Array<
    [string, (...args: unknown[]) => unknown]
  >) {
    ipcHandlers.set(channel, handler);
  }
  return { ipcHandlers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  autoUpdater.removeAllListeners();
  setPlatform(ORIGINAL_PLATFORM as NodeJS.Platform);
  if (ORIGINAL_APPIMAGE === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = ORIGINAL_APPIMAGE;
});

const UPDATE_INFO = { version: "1.2.3", releaseNotes: "Bug fixes" };

describe("auto-updater event contract", () => {
  it("does NOT announce 'ready' when an update is merely detected (update-available)", async () => {
    await freshSetup();
    sentStates.length = 0;

    autoUpdater.emit("update-available", UPDATE_INFO);

    // Regression guard: update-available must not collapse into the "ready"
    // (downloaded) stage. The renderer's update:check IPC reply already carries
    // availability; pushing "ready" here makes the renderer persist a
    // not-yet-downloaded version as pending and skip the download entirely.
    expect(readyStates()).toEqual([]);
    expect(sentStates).toEqual([]);
  });

  it("announces 'ready' only when the update is actually downloaded (update-downloaded)", async () => {
    await freshSetup();
    sentStates.length = 0;

    autoUpdater.emit("update-downloaded", UPDATE_INFO);

    expect(sentStates).toEqual([
      {
        channel: "update:state",
        state: { stage: "ready", version: "1.2.3", releaseNotes: "Bug fixes" },
      },
    ]);
  });
});

describe("auto-updater IPC contract", () => {
  it("update:check reports availability without pushing 'ready'", async () => {
    const { ipcHandlers } = await freshSetup();
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      updateInfo: { version: "1.2.3", releaseNotes: "Bug fixes" },
    });
    sentStates.length = 0;

    const result = await ipcHandlers.get("update:check")!();

    expect(result).toEqual({
      supported: true,
      available: true,
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    // The check handler must not push a "ready" state on availability — that
    // stage is reserved for update-downloaded.
    expect(readyStates()).toEqual([]);
  });

  it("update:download rejects on failure so the renderer doesn't treat it as staged", async () => {
    // Without re-throwing, the IPC resolves with undefined on failure and the
    // renderer's `await downloadUpdate()` would persist pendingUpdateVersion
    // for an update that was never actually downloaded — re-introducing the
    // suppression bug on every transient download failure.
    const { ipcHandlers } = await freshSetup();
    autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error("sha mismatch"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(ipcHandlers.get("update:download")!()).rejects.toThrow("sha mismatch");
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(ipcHandlers.get("update:getState")!()).toEqual({
      stage: "error",
      error: "sha mismatch",
    });
    errorSpy.mockRestore();
  });
});
