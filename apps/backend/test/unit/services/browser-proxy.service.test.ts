import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  ws: {
    sent: [] as Array<{ url: string; method: string; params: Record<string, unknown> }>,
    streamInputs: [] as Array<Record<string, unknown>>,
    markerByUrl: {} as Record<string, string | null>,
    closeOnceForMethodByUrl: {} as Record<string, boolean>,
    instances: [] as Array<{
      url: string;
      close: () => void;
      emit: (event: string, ...args: unknown[]) => void;
    }>,
  },
  agentBrowser: {
    calls: [] as Array<{ file: string; args: string[]; env: Record<string, string | undefined> }>,
    tabs: [] as Array<{
      active?: boolean;
      index: number;
      title?: string;
      type: string;
      url: string;
    }>,
  },
  broadcast: {
    frames: [] as string[],
    targeted: [] as Array<{
      connectionId: string;
      payload: string;
      options?: Record<string, unknown>;
    }>,
    removedListener: null as null | ((connectionId: string) => void),
  },
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: { env?: Record<string, string | undefined> },
    callback: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    mockState.agentBrowser.calls.push({ file, args, env: options.env ?? {} });
    let stdout = JSON.stringify({ success: true });
    if (args.includes("tab") && args.includes("list")) {
      stdout = JSON.stringify({ success: true, data: { tabs: mockState.agentBrowser.tabs } });
    } else if (args[2] === "tab" && /^\d+$/.test(args[3] ?? "")) {
      const index = Number(args[3]);
      const tab = mockState.agentBrowser.tabs.find((item) => item.index === index);
      stdout = JSON.stringify({ success: true, data: tab ?? { index } });
    }
    queueMicrotask(() => callback(null, stdout, ""));
    return { on: () => undefined };
  },
}));

vi.mock("ws", () => {
  type Handler = (...args: unknown[]) => void;

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = FakeWebSocket.OPEN;
    private readonly handlers = new Map<string, Set<Handler>>();

    constructor(readonly url: string) {
      mockState.ws.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    on(event: string, handler: Handler): this {
      let handlers = this.handlers.get(event);
      if (!handlers) {
        handlers = new Set();
        this.handlers.set(event, handlers);
      }
      handlers.add(handler);
      return this;
    }

    once(event: string, handler: Handler): this {
      const onceHandler: Handler = (...args) => {
        this.off(event, onceHandler);
        handler(...args);
      };
      return this.on(event, onceHandler);
    }

    off(event: string, handler: Handler): this {
      this.handlers.get(event)?.delete(handler);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(payload: string): void {
      if (this.url.startsWith("ws://127.0.0.1:")) {
        mockState.ws.streamInputs.push(JSON.parse(payload) as Record<string, unknown>);
        return;
      }
      const msg = JSON.parse(payload) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      mockState.ws.sent.push({ url: this.url, method: msg.method, params: msg.params ?? {} });
      const closeKey = `${this.url}:${msg.method}`;
      if (mockState.ws.closeOnceForMethodByUrl[closeKey]) {
        delete mockState.ws.closeOnceForMethodByUrl[closeKey];
        this.close();
        return;
      }
      const result =
        msg.method === "Runtime.evaluate"
          ? { result: { value: mockState.ws.markerByUrl[this.url] ?? null } }
          : msg.method === "Page.captureScreenshot"
            ? { data: "png" }
            : msg.method === "Target.createTarget"
              ? { targetId: "created-target" }
              : {};
      queueMicrotask(() => {
        this.emit(
          "message",
          JSON.stringify({
            id: msg.id,
            result,
          })
        );
      });
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  }

  return { WebSocket: FakeWebSocket };
});

vi.mock("../../../src/services/ws.service", () => ({
  broadcast: (payload: string) => {
    mockState.broadcast.frames.push(payload);
  },
  sendToConnection: (connectionId: string, payload: string, options?: Record<string, unknown>) => {
    mockState.broadcast.targeted.push({ connectionId, payload, options });
    return true;
  },
  onConnectionRemoved: (listener: (connectionId: string) => void) => {
    mockState.broadcast.removedListener = listener;
    return () => {
      mockState.broadcast.removedListener = null;
    };
  },
}));

describe("browser-proxy.service", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.ws.sent = [];
    mockState.ws.streamInputs = [];
    mockState.ws.markerByUrl = {};
    mockState.ws.closeOnceForMethodByUrl = {};
    mockState.ws.instances = [];
    mockState.agentBrowser.calls = [];
    mockState.agentBrowser.tabs = [];
    mockState.broadcast.frames = [];
    mockState.broadcast.targeted = [];
    mockState.broadcast.removedListener = null;
    delete process.env.BROWSER_CDP_URL;
    process.env.CDP_PORT = "19222";
    process.env.BROWSER_PROXY_NATIVE_TAB_TIMEOUT_MS = "0";
  });

  it("prefers a registered native Electron webview target over creating a new target", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        fetchCalls.push(href);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-target",
              type: "webview",
              url: "https://example.com/",
              webSocketDebuggerUrl: "ws://native-target",
            },
            {
              id: "other-target",
              type: "page",
              url: "https://example.com/",
              webSocketDebuggerUrl: "ws://other-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({ webSocketDebuggerUrl: "ws://browser" });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-target"] = "tab-1";
    mockState.ws.markerByUrl["ws://other-target"] = "other-tab";
    mockState.agentBrowser.tabs = [
      { index: 0, type: "page", title: "Deus", url: "http://localhost:1420/" },
      { index: 1, type: "webview", url: "https://example.com/" },
    ];

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-1",
      workspaceId: "ws-1",
      url: "https://example.com/",
    });

    await service.attachBrowserTab({
      tabId: "tab-1",
      workspaceId: "ws-1",
      width: 1024,
      height: 768,
      url: "https://example.com/",
    });

    expect(fetchCalls.some((url) => url.includes("/json/new?"))).toBe(false);
    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://native-target",
        method: "Page.bringToFront",
      })
    );
    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ url: "ws://native-target", method: "Page.captureScreenshot" })
    );
    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://native-target",
        method: "Page.startScreencast",
        params: expect.objectContaining({
          format: "jpeg",
          quality: 72,
          everyNthFrame: 1,
        }),
      })
    );
    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ method: "Target.createTarget" })
    );
    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ method: "Page.navigate" })
    );
    expect(mockState.agentBrowser.calls).toEqual([]);

    const nativeSocket = mockState.ws.instances
      .filter((instance) => instance.url === "ws://native-target")
      .at(-1);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    nativeSocket?.emit(
      "message",
      JSON.stringify({
        method: "Page.screencastFrame",
        params: {
          data: "abc",
          metadata: { deviceWidth: 320, deviceHeight: 240 },
          sessionId: 7,
        },
      })
    );
    dateNow.mockRestore();

    expect(mockState.broadcast.frames.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "q:event",
      event: "browser:frame",
      data: {
        tabId: "tab-1",
        format: "jpeg",
        data: "abc",
        width: 320,
        height: 240,
        timestamp: expect.any(Number),
      },
    });
    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://native-target",
        method: "Page.screencastFrameAck",
        params: { sessionId: 7 },
      })
    );

    service.sendBrowserInput({
      tabId: "tab-1",
      kind: "mouse",
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });
    await vi.waitFor(() => {
      expect(mockState.ws.sent).toContainEqual(
        expect.objectContaining({
          url: "ws://native-target",
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mousePressed",
            x: 10,
            y: 20,
            button: "left",
            clickCount: 1,
            modifiers: 0,
          },
        })
      );
    });

    service.sendBrowserInput({
      tabId: "tab-1",
      kind: "key",
      type: "keyDown",
      key: "!",
      code: "Digit1",
      text: "!",
    });
    await vi.waitFor(() => {
      expect(mockState.ws.sent).toContainEqual(
        expect.objectContaining({
          url: "ws://native-target",
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyDown",
            key: "!",
            code: "Digit1",
            modifiers: 0,
          },
        })
      );
      expect(mockState.ws.sent).toContainEqual(
        expect.objectContaining({
          url: "ws://native-target",
          method: "Input.dispatchKeyEvent",
          params: {
            type: "char",
            key: "!",
            code: "Digit1",
            text: "!",
            unmodifiedText: "!",
            modifiers: 0,
          },
        })
      );
    });

    await expect(service.captureBrowserScreenshot({ tabId: "tab-1" })).resolves.toBe(
      "data:image/png;base64,png"
    );
  });

  it("disambiguates duplicate native webviews with the same URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "old-target",
              type: "webview",
              title: "Seznam",
              url: "https://www.seznam.cz/",
              webSocketDebuggerUrl: "ws://old-target",
            },
            {
              id: "current-target",
              type: "webview",
              title: "Seznam",
              url: "https://www.seznam.cz/",
              webSocketDebuggerUrl: "ws://current-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({ webSocketDebuggerUrl: "ws://browser" });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://old-target"] = "old-tab";
    mockState.ws.markerByUrl["ws://current-target"] = "tab-duplicate";
    mockState.agentBrowser.tabs = [
      { index: 0, type: "page", title: "Deus", url: "http://localhost:1420/" },
      { index: 1, type: "webview", title: "Seznam", url: "https://www.seznam.cz/" },
      { index: 7, type: "webview", title: "Seznam", url: "https://www.seznam.cz/" },
    ];

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-duplicate",
      workspaceId: "ws-1",
      url: "https://www.seznam.cz/",
    });

    await service.attachBrowserTab({
      tabId: "tab-duplicate",
      workspaceId: "ws-1",
      width: 1024,
      height: 768,
      url: "https://www.seznam.cz/",
    });

    expect(mockState.agentBrowser.calls).toEqual([]);
  });

  it("falls back to creating a CDP target when no registered target can be matched", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        fetchCalls.push(href);
        if (href.endsWith("/json")) {
          return jsonResponse([]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        if (href.includes("/json/new?")) {
          return jsonResponse({
            id: "created-target",
            type: "page",
            url: "https://github.com/",
            webSocketDebuggerUrl: "ws://created-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-2",
      workspaceId: "ws-1",
      width: 800,
      height: 600,
      url: "https://github.com/",
    });

    expect(fetchCalls).toContain("http://127.0.0.1:19222/json/new?https%3A%2F%2Fgithub.com%2F");
    expect(mockState.agentBrowser.calls).toContainEqual(
      expect.objectContaining({ args: ["--cdp", "ws://created-target", "get", "url", "--json"] })
    );
  });

  it("waits for browser-created targets to appear in the CDP target list", async () => {
    const fetchCalls: string[] = [];
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        fetchCalls.push(href);
        if (href.endsWith("/json/version")) {
          return jsonResponse({ webSocketDebuggerUrl: "ws://browser" });
        }
        if (href.endsWith("/json")) {
          listCalls += 1;
          return jsonResponse(
            listCalls < 2
              ? []
              : [
                  {
                    id: "created-target",
                    type: "page",
                    url: "https://github.com/",
                    webSocketDebuggerUrl: "ws://created-target",
                  },
                ]
          );
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.agentBrowser.tabs = [
      { index: 0, type: "page", title: "GitHub", url: "https://github.com/" },
    ];

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-created-by-browser-ws",
      width: 800,
      height: 600,
      url: "https://github.com/",
    });

    expect(fetchCalls.some((url) => url.includes("/json/new?"))).toBe(false);
    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://browser",
        method: "Target.createTarget",
        params: { url: "https://github.com/" },
      })
    );
    expect(mockState.agentBrowser.calls).toContainEqual(
      expect.objectContaining({
        args: ["--cdp", "ws://browser", "tab", "list", "--json"],
      })
    );
  });

  it("uses compact agent-browser session names for long tab ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) return jsonResponse([]);
        if (href.endsWith("/json/version")) return jsonResponse({});
        if (href.includes("/json/new?")) {
          return jsonResponse({
            id: "created-target",
            type: "page",
            url: "https://github.com/",
            webSocketDebuggerUrl: "ws://created-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "ws-019d839c-tab-1778413943897-uwj2-21ea025b-be3e-48b0-b825-ae57e729ff8e",
      workspaceId: "ws-1",
      width: 800,
      height: 600,
      url: "https://github.com/",
    });

    const sessionName = mockState.agentBrowser.calls[0]?.env.AGENT_BROWSER_SESSION;
    expect(sessionName).toMatch(/^deus-[0-9a-f]{8}-[0-9a-f]{16}$/);
    expect(sessionName?.length).toBeLessThanOrEqual(30);
    expect(mockState.agentBrowser.calls[0]?.env.AGENT_BROWSER_SOCKET_DIR).toBe("/tmp");
  });

  it("targets stream frames to the attaching connection and forwards input to agent-browser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) return jsonResponse([]);
        if (href.endsWith("/json/version")) return jsonResponse({});
        if (href.includes("/json/new?")) {
          return jsonResponse({
            id: "created-target",
            type: "page",
            url: "https://github.com/",
            webSocketDebuggerUrl: "ws://created-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab(
      {
        tabId: "tab-targeted",
        workspaceId: "ws-1",
        width: 800,
        height: 600,
        url: "https://github.com/",
      },
      "conn-1"
    );

    const stream = mockState.ws.instances.find((instance) =>
      instance.url.startsWith("ws://127.0.0.1:")
    );
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(1_000);
    stream?.emit(
      "message",
      JSON.stringify({
        type: "frame",
        data: "abc",
        metadata: { deviceWidth: 800, deviceHeight: 600 },
      })
    );
    dateNow.mockReturnValue(1_010);
    stream?.emit(
      "message",
      JSON.stringify({
        type: "frame",
        data: "too-fast",
        metadata: { deviceWidth: 800, deviceHeight: 600 },
      })
    );
    dateNow.mockRestore();

    const targetedFrame = mockState.broadcast.targeted.find((item) => {
      const payload = JSON.parse(item.payload) as { event?: string; data?: { tabId?: string } };
      return item.connectionId === "conn-1" && payload.event === "browser:frame";
    });
    expect(targetedFrame?.options).toEqual({ maxBufferedAmount: 1_000_000 });
    expect(JSON.parse(targetedFrame?.payload ?? "{}")).toEqual({
      type: "q:event",
      event: "browser:frame",
      data: {
        tabId: "tab-targeted",
        data: "abc",
        format: "jpeg",
        width: 800,
        height: 600,
        timestamp: expect.any(Number),
      },
    });
    expect(
      mockState.broadcast.targeted.filter((item) => {
        const payload = JSON.parse(item.payload) as { event?: string };
        return payload.event === "browser:frame";
      })
    ).toHaveLength(1);

    service.sendBrowserInput({
      tabId: "tab-targeted",
      kind: "mouse",
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });

    await vi.waitFor(() => {
      expect(mockState.ws.streamInputs).toContainEqual({
        type: "input_mouse",
        eventType: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      });
    });
  });

  it("cleans up owned browser sessions when the attaching connection disconnects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-cleanup-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://native-cleanup-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) return jsonResponse({});
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-cleanup-target"] = "tab-cleanup";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-cleanup",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab(
      {
        tabId: "tab-cleanup",
        workspaceId: "ws-1",
        width: 900,
        height: 600,
        url: "http://localhost:3000/",
      },
      "conn-1"
    );

    mockState.broadcast.removedListener?.("conn-1");

    await vi.waitFor(() => {
      expect(mockState.broadcast.frames).toContainEqual(
        JSON.stringify({
          type: "q:event",
          event: "browser:nativeTabCloseRequested",
          data: { tabId: "tab-cleanup", workspaceId: "ws-1" },
        })
      );
    });
  });

  it("asks the native desktop renderer to open a matching tab before falling back to target creation", async () => {
    let nativeRegistered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse(
            nativeRegistered
              ? [
                  {
                    id: "requested-target",
                    type: "webview",
                    url: "http://localhost:3000/",
                    webSocketDebuggerUrl: "ws://requested-target",
                  },
                ]
              : []
          );
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://requested-target"] = "tab-requested";
    process.env.BROWSER_PROXY_NATIVE_TAB_TIMEOUT_MS = "1000";

    const service = await import("../../../src/services/browser-proxy.service");
    const attach = service.attachBrowserTab({
      tabId: "tab-requested",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });

    await vi.waitFor(() => {
      expect(mockState.broadcast.frames).toContainEqual(
        JSON.stringify({
          type: "q:event",
          event: "browser:nativeTabRequested",
          data: {
            tabId: "tab-requested",
            workspaceId: "ws-1",
            url: "http://localhost:3000/",
          },
        })
      );
    });

    nativeRegistered = true;
    service.registerNativeBrowserTab({
      tabId: "tab-requested",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });
    await attach;

    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://requested-target",
        method: "Page.bringToFront",
      })
    );
    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ url: "ws://requested-target", method: "Page.captureScreenshot" })
    );
    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ method: "Target.createTarget" })
    );
  });

  it("asks the native desktop renderer to close registered native tabs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-close-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://native-close-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-close-target"] = "tab-close";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-close",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab({
      tabId: "tab-close",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });
    await service.closeBrowserTab({ tabId: "tab-close" });

    expect(mockState.broadcast.frames).toContainEqual(
      JSON.stringify({
        type: "q:event",
        event: "browser:nativeTabCloseRequested",
        data: { tabId: "tab-close", workspaceId: "ws-1" },
      })
    );
  });

  it("asks the native desktop renderer to activate an existing backing tab on reattach", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-activate-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://native-activate-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-activate-target"] = "tab-activate";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-activate",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab({
      tabId: "tab-activate",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });
    mockState.broadcast.frames = [];

    await service.attachBrowserTab({
      tabId: "tab-activate",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });

    expect(mockState.broadcast.frames).toContainEqual(
      JSON.stringify({
        type: "q:event",
        event: "browser:nativeTabRequested",
        data: {
          tabId: "tab-activate",
          workspaceId: "ws-1",
          url: "http://localhost:3000/",
        },
      })
    );
  });

  it("does not hijack another native tab while waiting for the requested tab marker", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        fetchCalls.push(href);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "other-native-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://other-native-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        if (href.includes("/json/new?")) {
          return jsonResponse({
            id: "created-target",
            type: "page",
            url: "http://localhost:3000/",
            webSocketDebuggerUrl: "ws://created-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://other-native-target"] = "other-tab";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "other-tab",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab({
      tabId: "requested-tab",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });

    expect(mockState.ws.sent).not.toContainEqual(
      expect.objectContaining({ url: "ws://other-native-target" })
    );
    expect(mockState.agentBrowser.calls).toContainEqual(
      expect.objectContaining({ args: ["--cdp", "ws://created-target", "get", "url", "--json"] })
    );
    expect(fetchCalls).toContain(
      "http://127.0.0.1:19222/json/new?http%3A%2F%2Flocalhost%3A3000%2F"
    );
  });

  it("uses BROWSER_CDP_URL when the backend points at a remote browser host", async () => {
    process.env.BROWSER_CDP_URL = "http://10.0.0.5:9222/";
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        fetchCalls.push(href);
        if (href === "http://10.0.0.5:9222/json") return jsonResponse([]);
        if (href === "http://10.0.0.5:9222/json/version") return jsonResponse({});
        if (href.startsWith("http://10.0.0.5:9222/json/new?")) {
          return jsonResponse({
            id: "created-target",
            type: "page",
            url: "https://github.com/",
            webSocketDebuggerUrl: "ws://created-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-3",
      width: 800,
      height: 600,
      url: "https://github.com/",
    });

    expect(fetchCalls).toContain("http://10.0.0.5:9222/json");
    expect(fetchCalls.some((url) => url.startsWith("http://10.0.0.5:9222/json/new?"))).toBe(true);
  });

  it("uses the visible preview height for mobile viewport streams", async () => {
    process.env.BROWSER_CDP_URL = "http://10.0.0.5:9222/";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href === "http://10.0.0.5:9222/json") return jsonResponse([]);
        if (href === "http://10.0.0.5:9222/json/version") return jsonResponse({});
        if (href.startsWith("http://10.0.0.5:9222/json/new?")) {
          return jsonResponse({
            id: "mobile-target",
            type: "page",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://mobile-target",
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-mobile",
      width: 1024,
      height: 640,
      url: "https://example.com/",
      isMobileView: true,
    });

    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://mobile-target",
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 390,
          height: 640,
          deviceScaleFactor: 3,
          mobile: true,
        },
      })
    );
    expect(mockState.agentBrowser.calls).toContainEqual(
      expect.objectContaining({ args: ["--cdp", "ws://mobile-target", "get", "url", "--json"] })
    );
  });

  it("reconnects to the CDP target when the socket closes before a later command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-reconnect-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://native-reconnect-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-reconnect-target"] = "tab-reconnect";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-reconnect",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab({
      tabId: "tab-reconnect",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });
    const firstSessionSocketCount = mockState.ws.instances.length;
    mockState.ws.instances
      .filter((instance) => instance.url === "ws://native-reconnect-target")
      .at(-1)
      ?.close();

    await expect(
      service.evaluateBrowserTab({
        tabId: "tab-reconnect",
        expression: "location.href",
      })
    ).resolves.toBe("tab-reconnect");

    expect(mockState.ws.instances.length).toBeGreaterThan(firstSessionSocketCount);
    expect(mockState.ws.sent).toContainEqual(
      expect.objectContaining({
        url: "ws://native-reconnect-target",
        method: "Runtime.evaluate",
        params: expect.objectContaining({ expression: "location.href" }),
      })
    );
  });

  it("retries once when a CDP command loses its socket in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith("/json")) {
          return jsonResponse([
            {
              id: "native-midflight-target",
              type: "webview",
              url: "http://localhost:3000/",
              webSocketDebuggerUrl: "ws://native-midflight-target",
            },
          ]);
        }
        if (href.endsWith("/json/version")) {
          return jsonResponse({});
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
    mockState.ws.markerByUrl["ws://native-midflight-target"] = "tab-midflight";

    const service = await import("../../../src/services/browser-proxy.service");
    service.registerNativeBrowserTab({
      tabId: "tab-midflight",
      workspaceId: "ws-1",
      url: "http://localhost:3000/",
    });

    await service.attachBrowserTab({
      tabId: "tab-midflight",
      workspaceId: "ws-1",
      width: 900,
      height: 600,
      url: "http://localhost:3000/",
    });

    mockState.ws.closeOnceForMethodByUrl["ws://native-midflight-target:Page.navigate"] = true;

    await expect(
      service.navigateBrowserTab({
        tabId: "tab-midflight",
        url: "https://github.com/",
      })
    ).resolves.toBeUndefined();

    expect(
      mockState.ws.sent.filter(
        (item) => item.url === "ws://native-midflight-target" && item.method === "Page.navigate"
      )
    ).toHaveLength(2);
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
