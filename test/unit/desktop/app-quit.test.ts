import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  handlers: new Map<string, () => unknown>(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  exited: vi.fn(),
  stop: vi.fn(),
  destroyTray: vi.fn(),
  install: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: (...args: unknown[]) => void) => mocks.events.set(event, handler),
    quit: mocks.quit,
    relaunch: mocks.relaunch,
    enableSandbox: vi.fn(),
  },
  autoUpdater: new EventEmitter(),
  BrowserWindow: class {
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      send: vi.fn(),
    };
    on = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    isDestroyed = () => false;
  },
  ipcMain: {
    // Handlers are called directly here; the window-only check is main-lifecycle's.
    get handle() {
      return (channel: string, handler: () => unknown) => mocks.handlers.set(channel, handler);
    },
    set handle(_wrapped) {},
    on: vi.fn(),
  },
  session: {
    defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }),
  },
  shell: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  net: { fetch: vi.fn() },
}));
vi.mock("electron-updater", () => ({
  autoUpdater: Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false }),
    quitAndInstall: mocks.install,
  }),
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("../../../apps/desktop/main/backend-process", () => ({
  spawnBackend: vi.fn().mockResolvedValue({ port: 12345 }),
  stopBackend: mocks.stop,
}));
vi.mock("../../../apps/desktop/main/native-handlers", () => ({ registerNativeHandlers: vi.fn() }));
vi.mock("../../../apps/desktop/main/browser-emulation", () => ({
  registerBrowserEmulationHandlers: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/browser-cookies", () => ({
  registerBrowserCookieHandlers: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/shell-env", () => ({ syncShellEnvironment: vi.fn() }));
vi.mock("../../../apps/desktop/main/app-menu", () => ({ setupAppMenu: vi.fn() }));
vi.mock("../../../apps/desktop/main/tray", () => ({
  setupTray: vi.fn(),
  destroyTray: mocks.destroyTray,
}));
vi.mock("../../../apps/desktop/main/install-preflight", () => ({
  ensureInstalledInApplications: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../../apps/desktop/main/runtime-env", () => ({
  configurePackagedMainRuntimeEnv: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/deus-cloud-auth", () => ({
  getStoredDeusCloudSessionToken: vi.fn(),
  registerDeusCloudAuthHandlers: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/deus-cloud-auth-contract", () => ({
  resolveDeusCloudUrl: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/deus-cloud-provision", () => ({ provisionAtStartup: vi.fn() }));
vi.mock("../../../apps/desktop/main/startup-diagnostics", () => ({
  formatStartupFailureDetail: vi.fn(),
  getMainLogPath: vi.fn(),
  initMainProcessLogging: vi.fn(),
  logMainProcess: vi.fn(),
}));

let finishBackend: () => void;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("APPIMAGE", "/fixture/Deus.AppImage");
  vi.stubEnv("DEUS_USER_DATA_DIR", "/fixture/deus-user-data");
  vi.stubEnv("DEUS_BACKEND_PORT", "");
  mocks.events.clear();
  mocks.handlers.clear();
  mocks.stop.mockReturnValue(
    new Promise<void>((resolve) => {
      finishBackend = resolve;
    })
  );
  mocks.quit.mockImplementation(() => {
    const event = { preventDefault: vi.fn() };
    mocks.events.get("before-quit")!(event);
    if (!event.preventDefault.mock.calls.length) mocks.exited();
  });
});

async function startApp(platform: "linux" | "darwin" = "linux", { archiveDownloaded = true } = {}) {
  Object.defineProperty(process, "platform", { value: platform });
  const { autoUpdater: nativeAutoUpdater } = await import("electron");
  nativeAutoUpdater.removeAllListeners();
  mocks.install.mockImplementation(() => {
    nativeAutoUpdater.emit("before-quit-for-update");
    mocks.quit();
  });
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.removeAllListeners();
  autoUpdater.autoRunAppAfterInstall = true;
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.handlers.has("update:install")).toBe(true));
  autoUpdater.emit("update-available", { version: "0.4.0" });
  if (archiveDownloaded) autoUpdater.emit("update-downloaded", { version: "0.4.0" });
  return { autoUpdater, nativeAutoUpdater };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
});

it("keeps normal Quit pending until cleanup finishes and ignores repeated requests", async () => {
  const { autoUpdater } = await startApp();
  mocks.quit();
  mocks.quit();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.destroyTray).toHaveBeenCalledOnce();
  expect(mocks.exited).not.toHaveBeenCalled();

  finishBackend();
  await vi.waitFor(() => expect(mocks.exited).toHaveBeenCalledOnce());
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.install).not.toHaveBeenCalled();
  // Auto-install on ordinary Quit can rename the AppImage without requesting
  // a restart. Only the explicit update signal may schedule a relaunch.
  autoUpdater.emit("appimage-filename-updated", "/fixture/Deus-0.4.0.AppImage");
  expect(mocks.relaunch).not.toHaveBeenCalled();
});

it("defers AppImage relaunch until cleanup finishes and uses the updated filename once", async () => {
  const { autoUpdater, nativeAutoUpdater } = await startApp();
  expect(autoUpdater.autoRunAppAfterInstall).toBe(false);
  autoUpdater.emit("appimage-filename-updated", "/fixture/Deus-0.4.0.AppImage");
  mocks.handlers.get("update:install")!();
  mocks.handlers.get("update:install")!();
  nativeAutoUpdater.emit("before-quit-for-update");
  mocks.quit();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.destroyTray).toHaveBeenCalledOnce();
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith(false, true);
  expect(mocks.relaunch).not.toHaveBeenCalled();
  expect(mocks.exited).not.toHaveBeenCalled();

  finishBackend();
  await vi.waitFor(() =>
    expect(mocks.relaunch).toHaveBeenCalledExactlyOnceWith({
      execPath: "/fixture/Deus-0.4.0.AppImage",
    })
  );
  expect(mocks.exited).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("does not replace an already-requested normal Quit with an update restart", async () => {
  await startApp();
  mocks.quit();
  mocks.handlers.get("update:install")!();
  finishBackend();
  await vi.waitFor(() => expect(mocks.exited).toHaveBeenCalledOnce());
  expect(mocks.relaunch).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("keeps the backend alive after a failed install and permits a subsequent update", async () => {
  const { autoUpdater } = await startApp();
  mocks.install.mockImplementationOnce(() => {
    autoUpdater.emit("error", new Error("EACCES: AppImage directory is not writable"));
  });
  mocks.handlers.get("update:install")!();
  expect(mocks.handlers.get("update:getState")!()).toMatchObject({ stage: "error" });
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.destroyTray).not.toHaveBeenCalled();
  expect(mocks.exited).not.toHaveBeenCalled();
  expect(mocks.relaunch).not.toHaveBeenCalled();

  autoUpdater.emit("update-downloaded", { version: "0.4.0" });
  mocks.handlers.get("update:install")!();
  expect(mocks.install).toHaveBeenCalledTimes(2);
  expect(mocks.stop).toHaveBeenCalledOnce();
  finishBackend();
  await vi.waitFor(() =>
    expect(mocks.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: "/fixture/Deus.AppImage" })
  );
  expect(mocks.exited).toHaveBeenCalledOnce();
});

it("keeps macOS restart ownership with the native updater", async () => {
  const { autoUpdater, nativeAutoUpdater } = await startApp("darwin");
  expect(autoUpdater.autoRunAppAfterInstall).toBe(true);
  expect(mocks.handlers.get("update:getState")!()).toMatchObject({ stage: "downloading" });
  mocks.handlers.get("update:install")!();
  expect(mocks.install).not.toHaveBeenCalled();

  nativeAutoUpdater.emit("update-downloaded");
  mocks.handlers.get("update:install")!();
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith(false, true);
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.exited).not.toHaveBeenCalled();
  finishBackend();
  await vi.waitFor(() => expect(mocks.exited).toHaveBeenCalledOnce());
  expect(mocks.relaunch).not.toHaveBeenCalled();
});

it("discards a Mac archive that failed verification and offers Restart after a successful retry", async () => {
  const { autoUpdater, nativeAutoUpdater } = await startApp("darwin");
  autoUpdater.emit("error", new Error("Signature verification failed"));
  autoUpdater.emit("error", new Error("Signature verification failed"));
  nativeAutoUpdater.emit("update-downloaded");
  expect(mocks.handlers.get("update:getState")!()).toEqual({
    stage: "error",
    error: "Signature verification failed",
    version: "0.4.0",
  });
  mocks.handlers.get("update:install")!();
  expect(mocks.install).not.toHaveBeenCalled();

  const info = { version: "0.4.0", releaseNotes: "Changes" };
  autoUpdater.emit("update-available", info);
  autoUpdater.emit("update-downloaded", info);
  expect(mocks.handlers.get("update:getState")!()).toMatchObject({ stage: "downloading" });
  nativeAutoUpdater.emit("update-downloaded");
  expect(mocks.handlers.get("update:getState")!()).toEqual({ stage: "ready", ...info });
});

it("adds the archived version when setFeedURL fails before the Mac library announces the ZIP", async () => {
  const { autoUpdater, nativeAutoUpdater } = await startApp("darwin", { archiveDownloaded: false });
  const state = mocks.handlers.get("update:getState")!;
  const failure = { stage: "error", error: "Cannot get the signing requirement" };
  // MacUpdater forwards the native error synchronously.
  autoUpdater.emit("error", new Error(failure.error));
  expect(state()).toEqual(failure);
  autoUpdater.emit("update-downloaded", { version: "0.4.0" });
  expect(state()).toEqual({ ...failure, version: "0.4.0" });
  nativeAutoUpdater.emit("update-downloaded");
  mocks.handlers.get("update:install")!();
  expect(mocks.install).not.toHaveBeenCalled();

  autoUpdater.emit("checking-for-update");
  autoUpdater.emit("error", new Error("Feed unreachable"));
  autoUpdater.emit("update-downloaded", { version: "0.4.0" });
  expect(state()).toEqual({ stage: "error", error: "Feed unreachable" });

  autoUpdater.emit("update-available", { version: "0.5.0" });
  autoUpdater.emit("error", new Error("Download interrupted"));
  autoUpdater.emit("update-downloaded", { version: "0.4.0" });
  expect(state()).toEqual({ stage: "error", error: "Download interrupted" });
});
