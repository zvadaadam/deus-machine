import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  ws: {
    sent: [] as Array<{ url: string; method: string; params: Record<string, unknown> }>,
    streamInputs: [] as Array<Record<string, unknown>>,
    instances: [] as Array<{
      url: string;
      close: () => void;
      emit: (event: string, ...args: unknown[]) => void;
    }>,
  },
  agentBrowser: {
    calls: [] as Array<{ file: string; args: string[]; env: Record<string, string | undefined> }>,
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
  managedBrowser: {
    cdpBaseUrl: "http://managed-browser.test:9222",
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
    queueMicrotask(() => callback(null, JSON.stringify({ success: true }), ""));
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
      const result =
        msg.method === "Runtime.evaluate"
          ? { result: { value: "Example Domain" } }
          : msg.method === "Page.captureScreenshot"
            ? { data: "png" }
            : msg.method === "Target.createTarget"
              ? { targetId: "created-target" }
              : {};
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ id: msg.id, result }));
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

vi.mock("../../../src/services/managed-browser.service", () => ({
  getManagedBrowserCdpBaseUrl: async () => mockState.managedBrowser.cdpBaseUrl,
}));

describe("browser-proxy.service", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.ws.sent = [];
    mockState.ws.streamInputs = [];
    mockState.ws.instances = [];
    mockState.agentBrowser.calls = [];
    mockState.broadcast.frames = [];
    mockState.broadcast.targeted = [];
    mockState.broadcast.removedListener = null;
    mockState.managedBrowser.cdpBaseUrl = "http://managed-browser.test:9222";
    delete process.env.BROWSER_CDP_URL;
    process.env.CDP_PORT = "19222";
  });

  it("opens localhost tabs in managed Chrome instead of Electron webviews", async () => {
    const fetchCalls = stubManagedBrowserFetch("http://localhost:3000/");

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab(
      {
        tabId: "tab-local",
        workspaceId: "ws-1",
        width: 900,
        height: 600,
        url: "http://localhost:3000/",
      },
      "conn-1"
    );

    expect(fetchCalls).toContain("http://managed-browser.test:9222/json");
    expect(fetchCalls).toContain(
      "http://managed-browser.test:9222/json/new?http%3A%2F%2Flocalhost%3A3000%2F"
    );
    expect(mockState.broadcast.frames).toEqual([]);
    expect(mockState.agentBrowser.calls).toContainEqual(
      expect.objectContaining({
        args: ["--cdp", "ws://created-target", "get", "url", "--json"],
      })
    );
  });

  it("streams frames to the attaching connection and forwards input", async () => {
    stubManagedBrowserFetch("https://example.com/");

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab(
      {
        tabId: "tab-stream",
        width: 800,
        height: 600,
        url: "https://example.com/",
      },
      "conn-1"
    );

    const stream = mockState.ws.instances.find((instance) =>
      instance.url.startsWith("ws://127.0.0.1:")
    );
    stream?.emit(
      "message",
      JSON.stringify({
        type: "frame",
        data: "abc",
        metadata: { deviceWidth: 800, deviceHeight: 600 },
      })
    );

    const targetedFrame = mockState.broadcast.targeted.find((item) => {
      const payload = JSON.parse(item.payload) as { event?: string; data?: { tabId?: string } };
      return item.connectionId === "conn-1" && payload.event === "browser:frame";
    });
    expect(targetedFrame?.options).toEqual({ maxBufferedAmount: 1_000_000 });
    expect(JSON.parse(targetedFrame?.payload ?? "{}")).toEqual({
      type: "q:event",
      event: "browser:frame",
      data: {
        tabId: "tab-stream",
        data: "abc",
        format: "jpeg",
        width: 800,
        height: 600,
        timestamp: expect.any(Number),
      },
    });

    service.sendBrowserInput({
      tabId: "tab-stream",
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

  it("uses BROWSER_CDP_URL when explicitly configured", async () => {
    process.env.BROWSER_CDP_URL = "http://10.0.0.5:9222/";
    const fetchCalls = stubManagedBrowserFetch("https://github.com/", "http://10.0.0.5:9222");

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-configured-cdp",
      width: 800,
      height: 600,
      url: "https://github.com/",
    });

    expect(fetchCalls).toContain("http://10.0.0.5:9222/json");
    expect(fetchCalls.some((url) => url.startsWith("http://10.0.0.5:9222/json/new?"))).toBe(true);
  });

  it("closes owned browser targets when the attaching connection disconnects", async () => {
    const fetchCalls = stubManagedBrowserFetch("https://example.com/");

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab(
      {
        tabId: "tab-cleanup",
        width: 800,
        height: 600,
        url: "https://example.com/",
      },
      "conn-1"
    );

    mockState.broadcast.removedListener?.("conn-1");

    await vi.waitFor(() => {
      expect(fetchCalls).toContain("http://managed-browser.test:9222/json/close/created-target");
    });
  });

  it("captures screenshots through CDP", async () => {
    stubManagedBrowserFetch("https://example.com/");

    const service = await import("../../../src/services/browser-proxy.service");
    await service.attachBrowserTab({
      tabId: "tab-screenshot",
      width: 800,
      height: 600,
      url: "https://example.com/",
    });

    await expect(service.captureBrowserScreenshot({ tabId: "tab-screenshot" })).resolves.toBe(
      "data:image/png;base64,png"
    );
  });
});

function stubManagedBrowserFetch(
  url: string,
  baseUrl = mockState.managedBrowser.cdpBaseUrl
): string[] {
  const fetchCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (rawUrl: string | URL) => {
      const href = String(rawUrl);
      fetchCalls.push(href);
      if (href === `${baseUrl}/json`) return jsonResponse([]);
      if (href === `${baseUrl}/json/version`) return jsonResponse({});
      if (href.startsWith(`${baseUrl}/json/new?`)) {
        return jsonResponse({
          id: "created-target",
          type: "page",
          url,
          webSocketDebuggerUrl: "ws://created-target",
        });
      }
      if (href === `${baseUrl}/json/close/created-target`) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch: ${href}`);
    })
  );
  return fetchCalls;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
