import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAttachBrowserTab = vi.fn();
const mockRegisterNativeBrowserTab = vi.fn();
const mockUnregisterNativeBrowserTab = vi.fn();
const mockDetachBrowserTab = vi.fn();
const mockCloseBrowserTab = vi.fn();
const mockNavigateBrowserTab = vi.fn();
const mockGoBackBrowserTab = vi.fn();
const mockGoForwardBrowserTab = vi.fn();
const mockReloadBrowserTab = vi.fn();
const mockResizeBrowserTab = vi.fn();
const mockSendBrowserInput = vi.fn();
const mockEvaluateBrowserTab = vi.fn();
const mockCaptureBrowserScreenshot = vi.fn();

vi.mock("../../../src/services/browser-proxy.service", () => ({
  attachBrowserTab: (...args: unknown[]) => mockAttachBrowserTab(...args),
  registerNativeBrowserTab: (...args: unknown[]) => mockRegisterNativeBrowserTab(...args),
  unregisterNativeBrowserTab: (...args: unknown[]) => mockUnregisterNativeBrowserTab(...args),
  detachBrowserTab: (...args: unknown[]) => mockDetachBrowserTab(...args),
  closeBrowserTab: (...args: unknown[]) => mockCloseBrowserTab(...args),
  navigateBrowserTab: (...args: unknown[]) => mockNavigateBrowserTab(...args),
  goBackBrowserTab: (...args: unknown[]) => mockGoBackBrowserTab(...args),
  goForwardBrowserTab: (...args: unknown[]) => mockGoForwardBrowserTab(...args),
  reloadBrowserTab: (...args: unknown[]) => mockReloadBrowserTab(...args),
  resizeBrowserTab: (...args: unknown[]) => mockResizeBrowserTab(...args),
  sendBrowserInput: (...args: unknown[]) => mockSendBrowserInput(...args),
  evaluateBrowserTab: (...args: unknown[]) => mockEvaluateBrowserTab(...args),
  captureBrowserScreenshot: (...args: unknown[]) => mockCaptureBrowserScreenshot(...args),
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({}) as unknown,
  DB_PATH: "/fake/user-data/deus.db",
}));
vi.mock("../../../src/db", () => ({
  getSessionRaw: vi.fn(),
  getWorkspaceForMiddleware: vi.fn(),
}));
vi.mock("../../../src/middleware/workspace-loader", () => ({ computeWorkspacePath: vi.fn() }));
vi.mock("../../../src/services/message-writer", () => ({ writeUserMessage: vi.fn() }));
vi.mock("../../../src/services/pty.service", () => ({
  spawnPty: vi.fn(),
  writeToPty: vi.fn(),
  resizePty: vi.fn(),
  killPty: vi.fn(),
}));
vi.mock("../../../src/services/fs-watcher.service", () => ({
  watchWorkspace: vi.fn(),
  unwatchWorkspace: vi.fn(),
}));
vi.mock("../../../src/services/route-delegate", () => ({ delegateToRoute: vi.fn() }));
vi.mock("../../../src/services/agent/persistence", () => ({ persistSessionError: vi.fn() }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/service", () => ({
  isConnected: () => true,
  forwardTurn: vi.fn(),
  stopSession: vi.fn(),
  resolveAapPaths: vi.fn(),
}));
vi.mock("../../../src/services/simulator-context", () => ({}));
vi.mock("../../../src/services/aap", () => ({ launchApp: vi.fn(), stopApp: vi.fn() }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: vi.fn() }));

import { runCommand } from "../../../src/services/agent/commands";

describe("agent/commands — browser proxy command handlers", () => {
  beforeEach(() => {
    mockAttachBrowserTab.mockReset();
    mockAttachBrowserTab.mockResolvedValue(undefined);
    mockRegisterNativeBrowserTab.mockReset();
    mockUnregisterNativeBrowserTab.mockReset();
    mockDetachBrowserTab.mockResolvedValue(undefined);
    mockCloseBrowserTab.mockResolvedValue(undefined);
    mockNavigateBrowserTab.mockResolvedValue(undefined);
    mockGoBackBrowserTab.mockResolvedValue(undefined);
    mockGoForwardBrowserTab.mockResolvedValue(undefined);
    mockReloadBrowserTab.mockResolvedValue(undefined);
    mockResizeBrowserTab.mockResolvedValue(undefined);
    mockSendBrowserInput.mockResolvedValue(undefined);
    mockEvaluateBrowserTab.mockResolvedValue("ok");
    mockCaptureBrowserScreenshot.mockResolvedValue("data:image/png;base64,abc");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards browser:attach with workspace, viewport, url, and mobile mode", async () => {
    await expect(
      runCommand(
        "browser:attach",
        {
          tabId: "tab-1",
          workspaceId: "ws-1",
          width: 1024,
          height: 768,
          url: "https://github.com",
          isMobileView: true,
        },
        { connectionId: "conn-1" }
      )
    ).resolves.toEqual({});

    expect(mockAttachBrowserTab).toHaveBeenCalledWith(
      {
        tabId: "tab-1",
        workspaceId: "ws-1",
        width: 1024,
        height: 768,
        url: "https://github.com",
        isMobileView: true,
      },
      "conn-1"
    );
  });

  it("rejects browser:attach without numeric dimensions", async () => {
    await expect(runCommand("browser:attach", { tabId: "tab-1", width: 1024 })).rejects.toThrow(
      /width and height/
    );
    expect(mockAttachBrowserTab).not.toHaveBeenCalled();
  });

  it("registers and unregisters a native Electron webview target", async () => {
    await runCommand("browser:registerNativeTab", {
      tabId: "tab-1",
      workspaceId: "ws-1",
      url: "https://example.com",
    });
    await runCommand("browser:unregisterNativeTab", { tabId: "tab-1" });

    expect(mockRegisterNativeBrowserTab).toHaveBeenCalledWith({
      tabId: "tab-1",
      workspaceId: "ws-1",
      url: "https://example.com",
    });
    expect(mockUnregisterNativeBrowserTab).toHaveBeenCalledWith({ tabId: "tab-1" });
  });

  it("parses mouse, wheel, key, and touch input payloads", async () => {
    await runCommand("browser:input", {
      tabId: "tab-1",
      kind: "mouse",
      inputType: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      modifiers: 4,
    });
    await runCommand("browser:input", {
      tabId: "tab-1",
      kind: "wheel",
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: 120,
    });
    await runCommand("browser:input", {
      tabId: "tab-1",
      kind: "key",
      inputType: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
    });
    await runCommand("browser:input", {
      tabId: "tab-1",
      kind: "touch",
      inputType: "touchStart",
      touchPoints: [{ id: 1, x: 12, y: 34 }],
    });

    expect(mockSendBrowserInput).toHaveBeenNthCalledWith(1, {
      tabId: "tab-1",
      kind: "mouse",
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      modifiers: 4,
    });
    expect(mockSendBrowserInput).toHaveBeenNthCalledWith(2, {
      tabId: "tab-1",
      kind: "wheel",
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: 120,
      modifiers: 0,
    });
    expect(mockSendBrowserInput).toHaveBeenNthCalledWith(3, {
      tabId: "tab-1",
      kind: "key",
      type: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
    expect(mockSendBrowserInput).toHaveBeenNthCalledWith(4, {
      tabId: "tab-1",
      kind: "touch",
      type: "touchStart",
      touchPoints: [{ id: 1, x: 12, y: 34 }],
      modifiers: 0,
    });
  });

  it("rejects oversized keyboard input payloads", async () => {
    await expect(
      runCommand("browser:input", {
        tabId: "tab-1",
        kind: "key",
        inputType: "keyDown",
        key: "a",
        code: "KeyA",
        text: "x".repeat(257),
      })
    ).rejects.toThrow(/text is too long/);
  });

  it("returns eval and screenshot command payloads", async () => {
    await expect(
      runCommand("browser:eval", { tabId: "tab-1", expression: "document.title" })
    ).resolves.toEqual({ result: "ok" });
    await expect(
      runCommand("browser:captureScreenshot", {
        tabId: "tab-1",
        rect: { x: 1, y: 2, width: 300, height: 200 },
      })
    ).resolves.toEqual({ dataUrl: "data:image/png;base64,abc" });

    expect(mockEvaluateBrowserTab).toHaveBeenCalledWith({
      tabId: "tab-1",
      expression: "document.title",
    });
    expect(mockCaptureBrowserScreenshot).toHaveBeenCalledWith({
      tabId: "tab-1",
      rect: { x: 1, y: 2, width: 300, height: 200 },
    });
  });
});
