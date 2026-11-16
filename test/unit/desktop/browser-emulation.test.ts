import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, args: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  contents: new Map<number, unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler),
  },
  webContents: { fromId: (id: number) => mocks.contents.get(id) },
}));

import { registerBrowserEmulationHandlers } from "../../../apps/desktop/main/browser-emulation";

function fakeContents(id: number, type: string, host?: { id: number }) {
  const wc = {
    id,
    getType: () => type,
    hostWebContents: host,
    isDestroyed: () => false,
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
    },
    setZoomFactor: vi.fn(),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    setDevToolsWebContents: vi.fn(),
  };
  mocks.contents.set(id, wc);
  return wc;
}

const mainWindow = fakeContents(1, "window");
const otherWindow = fakeContents(2, "window");
const ownGuest = fakeContents(10, "webview", mainWindow);
const ownDevtoolsHost = fakeContents(11, "webview", mainWindow);
const otherGuest = fakeContents(20, "webview", otherWindow);
const fromMain = { sender: mainWindow };

const call = (channel: string, args: unknown, event: unknown = fromMain) =>
  mocks.handlers.get(channel)!(event, args);

const emulation = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

beforeEach(() => {
  mocks.handlers.clear();
  registerBrowserEmulationHandlers();
});

describe("browser emulation and devtools handlers", () => {
  it("act on a <webview> guest hosted by the window that asks", async () => {
    await expect(
      call("browser_webview_emulation_set", { webContentsId: 10, ...emulation })
    ).resolves.toEqual({ success: true });
    expect(ownGuest.debugger.attach).toHaveBeenCalled();
    await expect(call("browser_webview_emulation_clear", { webContentsId: 10 })).resolves.toEqual({
      success: true,
    });
    expect(
      call("browser_webview_devtools_open", { webContentsId: 10, devtoolsWebContentsId: 11 })
    ).toEqual({ success: true });
    expect(ownGuest.setDevToolsWebContents).toHaveBeenCalledWith(ownDevtoolsHost);
    expect(call("browser_webview_devtools_close", { webContentsId: 10 })).toEqual({
      success: true,
    });
  });

  it.each([
    ["the asking window itself", 1],
    ["another window", 2],
    ["another window's guest", 20],
    ["an unknown id", 99],
    ["a non-number id", "10"],
  ])("refuse %s", async (_label, webContentsId) => {
    const refused = { success: false, error: "webContents not found" };
    await expect(
      call("browser_webview_emulation_set", { webContentsId, ...emulation })
    ).resolves.toEqual(refused);
    await expect(call("browser_webview_emulation_clear", { webContentsId })).resolves.toEqual(
      refused
    );
    expect(call("browser_webview_devtools_open", { webContentsId })).toEqual(refused);
    expect(call("browser_webview_devtools_close", { webContentsId })).toEqual(refused);
    for (const wc of [mainWindow, otherWindow, otherGuest]) {
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.openDevTools).not.toHaveBeenCalled();
      expect(wc.closeDevTools).not.toHaveBeenCalled();
      expect(wc.setZoomFactor).not.toHaveBeenCalled();
    }
  });

  it("refuse a DevTools host that is not the asking window's guest", () => {
    for (const devtoolsWebContentsId of [1, 20]) {
      expect(
        call("browser_webview_devtools_open", { webContentsId: 10, devtoolsWebContentsId })
      ).toEqual({ success: false, error: "devtools webContents not found" });
    }
    expect(ownGuest.setDevToolsWebContents).not.toHaveBeenCalledWith(mainWindow);
    expect(ownGuest.setDevToolsWebContents).not.toHaveBeenCalledWith(otherGuest);
  });
});
