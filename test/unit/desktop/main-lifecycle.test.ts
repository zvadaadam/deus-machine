import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceLink } from "@shared/workspace-link";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as MockWindow[],
  packaged: true,
  hidden: false,
  focusApp: vi.fn(),
  ready: vi.fn(),
  setAsDefaultProtocolClient: vi.fn(),
  spawn: vi.fn(),
  stop: vi.fn(),
  showMessageBox: vi.fn(),
  quit: vi.fn(),
  setTrayStatus: vi.fn(),
  appendSwitch: vi.fn(),
  registerSchemes: vi.fn(),
  handleProtocol: vi.fn(),
  openExternal: vi.fn(),
  enableSandbox: vi.fn(),
  handle: vi.fn(),
}));

class MockWindow {
  handlers = new Map<string, () => void>();
  destroyed = false;
  minimized = false;
  visible = false;
  webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    mainFrame: { parent: null, url: "app://deus/" },
  };
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
  isMinimized = () => (this.live(), this.minimized);
  isVisible = () => (this.live(), this.visible);
  restore = vi.fn(() => this.live());
  show = vi.fn(() => this.live());
  focus = vi.fn(() => this.live());
}

vi.mock("electron", () => ({
  app: {
    isHidden: () => mocks.hidden,
    focus: mocks.focusApp,
    get isPackaged() {
      return mocks.packaged;
    },
    setAsDefaultProtocolClient: mocks.setAsDefaultProtocolClient,
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: mocks.appendSwitch },
    whenReady: mocks.ready,
    on: (event: string, handler: (...args: unknown[]) => void) => mocks.events.set(event, handler),
    quit: mocks.quit,
    enableSandbox: mocks.enableSandbox,
  },
  autoUpdater: new EventEmitter(),
  BrowserWindow: MockWindow,
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { handle: mocks.handle, on: vi.fn() },
  session: {
    defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }),
  },
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

beforeEach(async () => {
  vi.resetModules();
  // The mocked module outlives resetModules: undo the last import's wrapping.
  (await import("electron")).ipcMain.handle = mocks.handle;
  vi.clearAllMocks();
  vi.stubEnv("DEUS_USER_DATA_DIR", "/fixture/deus-user-data");
  vi.stubEnv("DEUS_BACKEND_PORT", "");
  mocks.events.clear();
  mocks.ready.mockResolvedValue(undefined);
  mocks.packaged = true;
  mocks.hidden = false;
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
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];
  win.visible = true;

  mocks.events.get("second-instance")!({}, []);
  expect(win.focus).toHaveBeenCalledOnce();
  expect(win.webContents.send).not.toHaveBeenCalled();

  win.destroyed = true;
  win.handlers.get("closed")!();
  expect(() => mocks.events.get("second-instance")!({}, [])).not.toThrow();
  expect(win.focus).toHaveBeenCalledOnce();
});

it("activates the macOS app when a second launch restores its minimized window", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];
  win.minimized = true;

  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mocks.events.get("second-instance")!({}, []);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
  expect(win.restore).toHaveBeenCalledOnce();
  expect(mocks.focusApp).toHaveBeenCalledWith({ steal: true });
  expect(win.focus).toHaveBeenCalledOnce();
  expect(win.show).not.toHaveBeenCalled();
});

const workspaceId = "019adc01-16d0-7654-abcd-aabbccddeeff";
const sessionId = "019aDC01-16d1-4aBc-C321-001122334455";
const chat = { workspaceId, sessionId };

function openUrl(text: string) {
  const preventDefault = vi.fn();
  mocks.events.get("open-url")!({ preventDefault }, text);
  expect(preventDefault).toHaveBeenCalledOnce();
}

function takeLink(sender = mocks.windows[0].webContents, senderFrame = sender.mainFrame) {
  const [, handle] = mocks.handle.mock.calls.find(([name]) => name === "take_workspace_link")!;
  return handle({ sender, senderFrame });
}

it("keeps the startup window hidden when a link arrives before its first show", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];
  mocks.hidden = true;
  openUrl(workspaceLink(chat));
  expect(mocks.focusApp).toHaveBeenCalledTimes(process.platform === "darwin" ? 1 : 0);
  expect(win.show).not.toHaveBeenCalled();
  expect(win.focus).not.toHaveBeenCalled();
  expect(takeLink()).toEqual(chat);
});

it("keeps the macOS launch link until the window's own page asks for it", async () => {
  const ready = Promise.withResolvers<void>();
  mocks.ready.mockReturnValue(ready.promise);
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  openUrl(workspaceLink(chat));
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.windows).toHaveLength(0);
  ready.resolve();
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));

  const { webContents } = mocks.windows[0];
  expect(() => takeLink({ ...webContents })).toThrow(/only the app's window/);
  expect(() => takeLink(webContents, { parent: null, url: "https://example.com" })).toThrow();
  expect(takeLink()).toEqual(chat);
  expect(takeLink()).toBeNull();
});

it("brings the window forward and offers the latest valid link without broadcasting its ids", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];
  win.minimized = true;

  openUrl("deus://anything");
  expect(mocks.focusApp).not.toHaveBeenCalled();
  expect(win.restore).not.toHaveBeenCalled();
  expect(win.focus).not.toHaveBeenCalled();
  expect(win.webContents.send).not.toHaveBeenCalled();

  openUrl(workspaceLink({ workspaceId }));
  openUrl(workspaceLink(chat));
  openUrl(workspaceLink(chat) + "&extra=1");
  expect(mocks.focusApp).toHaveBeenCalledTimes(process.platform === "darwin" ? 2 : 0);
  expect(win.restore).toHaveBeenCalledTimes(2);
  expect(win.show).not.toHaveBeenCalled();
  expect(win.focus).toHaveBeenCalledTimes(2);
  expect(win.webContents.send.mock.calls).toEqual([
    ["workspace-link:available"],
    ["workspace-link:available"],
  ]);
  expect(takeLink()).toEqual(chat);
  openUrl("deus://workspace?file=/tmp");
  expect(takeLink()).toBeNull();
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

it("takes only a complete link argument on a Linux launch or second instance", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  const address = workspaceLink(chat);
  const argv = process.argv;
  try {
    process.argv = ["deus", address, "--other"];
    await import("../../../apps/desktop/main/index");
  } finally {
    process.argv = argv;
  }
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  expect(takeLink()).toEqual(chat);
  const win = mocks.windows[0];
  win.visible = true;
  for (const refused of [
    "deus://anything",
    address.replace("deus:", "DEUS:"),
    "deus://[",
    "  " + address,
  ]) {
    mocks.events.get("second-instance")!({}, ["deus", refused, "--other"]);
  }
  expect(mocks.focusApp).not.toHaveBeenCalled();
  expect(win.focus).not.toHaveBeenCalled();
  expect(win.webContents.send).not.toHaveBeenCalled();
  expect(takeLink()).toBeNull();

  mocks.events.get("second-instance")!({}, ["deus", "--link=" + address]);
  expect(win.focus).toHaveBeenCalledOnce();
  expect(win.webContents.send).not.toHaveBeenCalled();
  expect(takeLink()).toBeNull();
  mocks.events.get("second-instance")!({}, [
    "deus",
    address,
    workspaceLink({ workspaceId }),
    "deus://anything",
    "--other",
  ]);
  expect(win.focus).toHaveBeenCalledTimes(2);
  expect(win.webContents.send.mock.calls).toEqual([["workspace-link:available"]]);
  expect(takeLink()).toEqual({ workspaceId });
});

it("does not claim the installed app's scheme in development", async () => {
  mocks.packaged = false;
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  expect(mocks.setAsDefaultProtocolClient).not.toHaveBeenCalled();
});

it("tells the tray when a backend starts and when it exits", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  const hooks = mocks.spawn.mock.calls[0][0];

  hooks.onReady(12345);
  expect(mocks.setTrayStatus).toHaveBeenLastCalledWith("running");
  hooks.onExit("backend", 1, null);
  expect(mocks.setTrayStatus).toHaveBeenLastCalledWith("offline");
});

it("loads the packaged window from app://deus and opens no debugging port", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  const win = mocks.windows[0];

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
  expect(navigate(workspaceLink(chat))).toBe(false);

  const didAttach = win.webContents.on.mock.calls.find(
    ([event]) => event === "did-attach-webview"
  )![1];
  const guestContents = { id: 2, setWindowOpenHandler: vi.fn() };
  didAttach({}, guestContents);
  const [openPopup] = guestContents.setWindowOpenHandler.mock.calls[0];
  expect(openPopup({ url: workspaceLink(chat) })).toEqual({ action: "deny" });
  expect(win.webContents.send).not.toHaveBeenCalled();
  expect(mocks.openExternal).toHaveBeenCalledTimes(1);

  // A guest joins the Browser tab's session, whatever partition the page names:
  // that session is the one whose permissions are limited.
  const attach = win.webContents.on.mock.calls.find(
    ([event]) => event === "will-attach-webview"
  )![1] as (event: object, preferences: { partition?: string }, params: object) => void;
  const guest = { partition: "persist:other" };
  attach({}, guest, { src: "https://example.com/", partition: "persist:other" });
  expect(guest.partition).toBe("persist:browser");
});

it("sandboxes every renderer and answers IPC from the window's own page only", async () => {
  mocks.spawn.mockResolvedValue({ port: 12345 });
  const { ipcMain } = await import("electron");
  await import("../../../apps/desktop/main/index");
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  expect(mocks.enableSandbox).toHaveBeenCalledOnce();

  const listener = vi.fn(() => "answer");
  ipcMain.handle("fixture:channel", listener);
  const wrapped = mocks.handle.mock.calls.find(([channel]) => channel === "fixture:channel")![1];
  const contents = mocks.windows[0].webContents;
  const call = (sender: object, senderFrame: object | null) => () =>
    wrapped({ sender, senderFrame }, "argument");

  expect(call(contents, contents.mainFrame)()).toBe("answer");
  expect(listener).toHaveBeenCalledWith(expect.anything(), "argument");
  // A frame inside the window, a page of another origin, a Browser-tab guest.
  const frame = { parent: contents.mainFrame, url: "app://deus/" };
  expect(call(contents, frame)).toThrow(/answers only the app's window/);
  expect(call(contents, { parent: null, url: "https://example.com/" })).toThrow();
  expect(call({}, { parent: null, url: "app://deus/" })).toThrow();
  expect(call(contents, null)).toThrow();
  expect(listener).toHaveBeenCalledOnce();
});
