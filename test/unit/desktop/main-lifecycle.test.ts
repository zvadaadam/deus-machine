import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as Array<{
    handlers: Map<string, () => void>;
    destroyed: boolean;
    focus: ReturnType<typeof import("vitest").vi.fn>;
  }>,
  spawn: vi.fn(),
  stop: vi.fn(),
  showMessageBox: vi.fn(),
  quit: vi.fn(),
  setTrayStatus: vi.fn(),
  appendSwitch: vi.fn(),
  registerSchemes: vi.fn(),
  handleProtocol: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: mocks.appendSwitch },
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: (...args: unknown[]) => void) => mocks.events.set(event, handler),
    quit: mocks.quit,
  },
  autoUpdater: new EventEmitter(),
  BrowserWindow: class {
    handlers = new Map<string, () => void>();
    destroyed = false;
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() };
    constructor() {
      mocks.windows.push(this);
    }
    on = (event: string, handler: () => void) => this.handlers.set(event, handler);
    loadFile = vi.fn();
    loadURL = vi.fn();
    isDestroyed = () => this.destroyed;
    // A destroyed BrowserWindow throws on use, as Electron's does.
    private live() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
    }
    isMinimized = () => (this.live(), false);
    restore = () => this.live();
    focus = vi.fn(() => this.live());
  },
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openExternal: mocks.openExternal },
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemes, handle: mocks.handleProtocol },
  net: { fetch: vi.fn() },
}));
vi.mock("electron-updater", () => ({ autoUpdater: new EventEmitter() }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("../../../apps/desktop/main/backend-process", () => ({
  spawnBackend: mocks.spawn,
  stopBackend: mocks.stop,
}));
vi.mock("../../../apps/desktop/main/native-handlers", () => ({ registerNativeHandlers: vi.fn() }));
vi.mock("../../../apps/desktop/main/browser-emulation", () => ({
  registerBrowserEmulationHandlers: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/browser-cookies", () => ({
  registerBrowserCookieHandlers: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/auto-updater", () => ({
  registerUpdateHandlers: vi.fn(),
  setupAutoUpdater: vi.fn(),
}));
vi.mock("../../../apps/desktop/main/shell-env", () => ({ syncShellEnvironment: vi.fn() }));
vi.mock("../../../apps/desktop/main/app-menu", () => ({ setupAppMenu: vi.fn() }));
vi.mock("../../../apps/desktop/main/tray", () => ({
  setupTray: vi.fn(),
  destroyTray: vi.fn(),
  setTrayStatus: mocks.setTrayStatus,
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
  formatStartupFailureDetail: vi.fn(() => "detail"),
  getMainLogPath: vi.fn(),
  initMainProcessLogging: vi.fn(),
  logMainProcess: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEUS_USER_DATA_DIR", "/fixture/deus-user-data");
  vi.stubEnv("DEUS_BACKEND_PORT", "");
  vi.stubEnv("DEUS_AUTH_TOKEN", "");
  mocks.events.clear();
  mocks.windows.length = 0;
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.stop.mockResolvedValue(undefined);
  // Quitting runs before-quit, as Electron does.
  mocks.quit.mockImplementation(() => {
    mocks.events.get("before-quit")?.({ preventDefault: vi.fn() });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A backend start the test settles, as the real one would. */
function pendingBackend() {
  let reject!: (error: Error) => void;
  mocks.spawn.mockReturnValue(
    new Promise((_resolve, rej) => {
      reject = rej;
    })
  );
  return { fail: (message: string) => reject(new Error(message)) };
}

it("shows no failure when a Quit stops the backend while it is starting", async () => {
  const backend = pendingBackend();
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());

  mocks.quit(); // stopBackend kills the starting child...
  backend.fail("Backend exited before starting (code=null, signal=SIGTERM)"); // ...so the start rejects
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(mocks.showMessageBox).not.toHaveBeenCalled();
});

it("still reports a backend that fails to start on its own", async () => {
  const backend = pendingBackend();
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());

  backend.fail("Backend startup timeout (30000ms)");
  await vi.waitFor(() =>
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Failed to Start" })
    )
  );
});

it("forgets a closed window, so a second launch does not act on it", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345, authToken: "fixture" });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];

  mocks.events.get("second-instance")!({}, []);
  expect(win.focus).toHaveBeenCalledOnce();

  win.destroyed = true;
  win.handlers.get("closed")!();
  expect(() => mocks.events.get("second-instance")!({}, [])).not.toThrow();
  expect(win.focus).toHaveBeenCalledOnce();
});

it("tells the tray when a backend starts and when it exits", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345, authToken: "fixture" });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  const hooks = mocks.spawn.mock.calls[0][0];

  hooks.onReady(12345);
  expect(mocks.setTrayStatus).toHaveBeenLastCalledWith("running");
  hooks.onExit("backend", 1, null);
  expect(mocks.setTrayStatus).toHaveBeenLastCalledWith("offline");
});

it("loads the packaged window from app://deus and opens no debugging port", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345, authToken: "fixture" });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0] as unknown as {
    loadURL: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    webContents: { on: ReturnType<typeof vi.fn> };
  };

  // Registered before ready, as Electron requires, with an origin and fetch.
  expect(mocks.registerSchemes).toHaveBeenCalledWith([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  expect(mocks.handleProtocol).toHaveBeenCalledWith("app", expect.any(Function));
  expect(win.loadURL).toHaveBeenCalledWith("app://deus/");
  expect(win.loadFile).not.toHaveBeenCalled();
  expect(mocks.appendSwitch).not.toHaveBeenCalledWith("remote-debugging-port", expect.anything());
  expect(mocks.appendSwitch).not.toHaveBeenCalledWith(
    "remote-debugging-address",
    expect.anything()
  );

  // The window navigates within its own origin; anything else is refused, and
  // a web page goes to the system browser.
  const willNavigate = win.webContents.on.mock.calls.find(
    ([event]) => event === "will-navigate"
  )![1] as (event: { preventDefault: () => void }, url: string) => void;
  const navigate = (url: string) => {
    const preventDefault = vi.fn();
    willNavigate({ preventDefault }, url);
    return preventDefault.mock.calls.length === 0;
  };
  expect(navigate("app://deus/index.html")).toBe(true);
  expect(navigate("app://deus.evil/")).toBe(false);
  expect(
    navigate("file:///Applications/Deus.app/Contents/Resources/app.asar/out/renderer/index.html")
  ).toBe(false);
  expect(navigate("https://example.com/")).toBe(false);
  expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/");
});
