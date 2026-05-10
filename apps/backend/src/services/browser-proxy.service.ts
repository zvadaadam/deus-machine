// backend/src/services/browser-proxy.service.ts
// Browser streaming for hosted web clients.
//
// The hosted frontend cannot mount Electron's <webview>. Instead it asks the
// backend to attach to the exact Electron/CDP page target. Normal page targets
// use agent-browser's frame stream; Electron <webview> targets use CDP
// Page.startScreencast directly because agent-browser cannot reliably select
// Electron guest targets from the browser-level tab list.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { WebSocket, type RawData } from "ws";
import { broadcast as wsBroadcast, onConnectionRemoved, sendToConnection } from "./ws.service";
import type {
  BrowserProxyAttachParams,
  BrowserProxyConsoleEvent,
  BrowserProxyErrorEvent,
  BrowserProxyEvalParams,
  BrowserProxyFrameEvent,
  BrowserProxyInputParams,
  BrowserProxyNativeTabCloseRequestEvent,
  BrowserProxyNativeTabParams,
  BrowserProxyNativeTabRequestEvent,
  BrowserProxyNavigateParams,
  BrowserProxyResizeParams,
  BrowserProxyScreenshotParams,
  BrowserProxyStateEvent,
  BrowserProxyStreamTransport,
  BrowserProxyTabParams,
  BrowserProxyWebRtcDescriptionEvent,
  BrowserProxyWebRtcIceCandidateEvent,
  BrowserProxyWebRtcStopEvent,
} from "@shared/types/browser-proxy";

type JsonObject = Record<string, unknown>;
const require = createRequire(import.meta.url);

interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface NativeTabRegistration {
  tabId: string;
  workspaceId: string;
  url?: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
  method?: string;
  params?: JsonObject;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CDP_COMMAND_TIMEOUT_MS = 10_000;
const AGENT_BROWSER_COMMAND_TIMEOUT_MS = 10_000;
const AGENT_BROWSER_IDLE_TIMEOUT_MS = 30_000;
const AGENT_BROWSER_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const AGENT_BROWSER_STREAM_CONNECT_POLL_MS = 100;
const MAX_STREAM_WIDTH = 1920;
const MAX_STREAM_HEIGHT = 1080;
const MAX_FRAME_PAYLOAD_BYTES = 2_500_000;
const MAX_FRAME_BUFFERED_AMOUNT = 1_000_000;
const MIN_FRAME_INTERVAL_MS = 66;
const INPUT_RATE_PER_SECOND = 120;
const INPUT_RATE_BURST = 180;
const MIN_VIEWPORT_SIZE = 1;
const MOBILE_PREVIEW_WIDTH = 390;
const MOBILE_PREVIEW_DPR = 3;
const NATIVE_TAB_REQUEST_POLL_MS = 100;
const NATIVE_TAB_MARKER = "__DEUS_BROWSER_TAB_ID__";
const TARGET_RECONNECT_TIMEOUT_MS = 8_000;
const TARGET_RECONNECT_POLL_MS = 100;

const AGENT_BROWSER_BINARY = (() => {
  try {
    const pkgDir = dirname(require.resolve("agent-browser/package.json"));
    return join(pkgDir, "bin", "agent-browser.js");
  } catch {
    return "agent-browser";
  }
})();

function getCdpPort(): string {
  const port = process.env.CDP_PORT ?? "19222";
  if (!port) {
    throw new Error("CDP_PORT is not set. Start the Electron desktop app to enable browser relay.");
  }
  return port;
}

function getCdpBaseUrl(): string {
  const configured = process.env.BROWSER_CDP_URL;
  const baseUrl = configured || `http://127.0.0.1:${getCdpPort()}`;
  return baseUrl.replace(/\/+$/, "");
}

function usesNativeElectronCdp(): boolean {
  return !process.env.BROWSER_CDP_URL;
}

function emit(event: "browser:frame", data: BrowserProxyFrameEvent): void;
function emit(event: "browser:state", data: BrowserProxyStateEvent): void;
function emit(event: "browser:console", data: BrowserProxyConsoleEvent): void;
function emit(event: "browser:error", data: BrowserProxyErrorEvent): void;
function emit(event: "browser:nativeTabRequested", data: BrowserProxyNativeTabRequestEvent): void;
function emit(
  event: "browser:nativeTabCloseRequested",
  data: BrowserProxyNativeTabCloseRequestEvent
): void;
function emit(event: "browser:webrtcOffer", data: BrowserProxyWebRtcDescriptionEvent): void;
function emit(event: "browser:webrtcAnswer", data: BrowserProxyWebRtcDescriptionEvent): void;
function emit(event: "browser:webrtcIce", data: BrowserProxyWebRtcIceCandidateEvent): void;
function emit(event: "browser:webrtcStop", data: BrowserProxyWebRtcStopEvent): void;
function emit(event: string, data: unknown): void {
  wsBroadcast(JSON.stringify({ type: "q:event", event, data }));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isBlankUrl(url: string | undefined): boolean {
  return !url || url === "about:blank";
}

function isAppRendererTarget(target: CdpTarget): boolean {
  const url = target.url ?? "";
  return (
    url.startsWith("devtools://") ||
    url.startsWith("chrome-devtools://") ||
    url.startsWith("file://") ||
    url.startsWith("http://localhost:1420") ||
    url.startsWith("http://127.0.0.1:1420")
  );
}

function isUsablePageTarget(target: CdpTarget): boolean {
  return (
    (target.type === "page" || target.type === "webview") &&
    !!target.webSocketDebuggerUrl &&
    !isAppRendererTarget(target)
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`CDP request failed ${res.status}: ${url}`);
  return (await res.json()) as T;
}

async function listTargets(): Promise<CdpTarget[]> {
  return fetchJson<CdpTarget[]>(`${getCdpBaseUrl()}/json`);
}

async function getBrowserWsUrl(): Promise<string | null> {
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `${getCdpBaseUrl()}/json/version`
    );
    return version.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

async function findTargetById(targetId: string): Promise<CdpTarget | null> {
  const targets = await listTargets();
  return targets.find((target) => target.id === targetId) ?? null;
}

async function findTargetByUrl(url: string | undefined): Promise<CdpTarget | null> {
  if (isBlankUrl(url)) return null;
  const targets = await listTargets();
  return (
    targets.find(
      (target) =>
        isUsablePageTarget(target) && !claimedTargetIds.has(target.id) && target.url === url
    ) ?? null
  );
}

async function createTarget(url: string | undefined): Promise<CdpTarget> {
  const targetUrl = url || "about:blank";

  const browserWsUrl = await getBrowserWsUrl();
  if (browserWsUrl) {
    let browserClient: CdpClient | null = null;
    try {
      browserClient = await CdpClient.connect(browserWsUrl);
      const result = (await browserClient.send("Target.createTarget", {
        url: targetUrl,
      })) as { targetId?: string };
      if (result.targetId) {
        const created = await findTargetById(result.targetId);
        if (created?.webSocketDebuggerUrl) return created;
      }
    } catch {
      // Fall back to the HTTP endpoint below.
    } finally {
      browserClient?.close();
    }
  }

  const created = await fetchJson<CdpTarget>(
    `${getCdpBaseUrl()}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" }
  );
  if (!created.webSocketDebuggerUrl) {
    throw new Error("Created CDP target did not expose a debugger URL");
  }
  return created;
}

async function closeTarget(targetId: string): Promise<void> {
  const browserWsUrl = await getBrowserWsUrl();
  if (browserWsUrl) {
    let browserClient: CdpClient | null = null;
    try {
      browserClient = await CdpClient.connect(browserWsUrl);
      await browserClient.send("Target.closeTarget", { targetId });
      return;
    } catch {
      // Fall through to HTTP close.
    } finally {
      browserClient?.close();
    }
  }

  await fetch(`${getCdpBaseUrl()}/json/close/${encodeURIComponent(targetId)}`).catch(() => {});
}

class CdpClient {
  private id = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly handlers = new Map<string, Set<(params: JsonObject) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("close", () => this.rejectAll("CDP socket closed"));
    ws.on("error", (err) => this.rejectAll(err.message));
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const failTimer = setTimeout(() => {
        reject(new Error("Timed out connecting to CDP target"));
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, CDP_COMMAND_TIMEOUT_MS);

      ws.once("open", () => {
        clearTimeout(failTimer);
        resolve(new CdpClient(ws));
      });
      ws.once("error", (err) => {
        clearTimeout(failTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  on(method: string, handler: (params: JsonObject) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  send(method: string, params: JsonObject = {}): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: RawData): void {
    let msg: CdpResponse;
    try {
      msg = JSON.parse(raw.toString()) as CdpResponse;
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? `CDP error ${msg.error.code ?? ""}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(msg.params ?? {});
      } catch (err) {
        console.error(`[BrowserProxy] Event handler failed for ${msg.method}:`, err);
      }
    }
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

const claimedTargetIds = new Set<string>();
const sessions = new Map<string, BrowserProxySession>();
const pendingSessionCreates = new Map<string, Promise<BrowserProxySession>>();
const nativeTabRegistrations = new Map<string, NativeTabRegistration>();

interface AgentBrowserStreamFrame {
  data: string;
  width: number;
  height: number;
  timestamp: number;
}

interface AgentBrowserTab {
  active?: boolean;
  index?: number;
  title?: string;
  type?: string;
  url?: string;
}

interface AgentBrowserCommandResult {
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

class AgentBrowserStream {
  private ws: WebSocket | null = null;
  private startQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly port: number,
    private readonly agentBrowserSessionId: string,
    private readonly onFrame: (frame: AgentBrowserStreamFrame) => void,
    private readonly onError: (error: string) => void
  ) {}

  async start(target: CdpTarget): Promise<void> {
    this.stopped = false;
    const next = this.startQueue.then(
      () => this.startInner(target),
      () => this.startInner(target)
    );
    this.startQueue = next.catch(() => {});
    return next;
  }

  sendInput(params: BrowserProxyInputParams): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Browser stream is not connected");
    }
    ws.send(JSON.stringify(toAgentBrowserInput(params)));
  }

  close(): void {
    this.stopped = true;
    this.closeSocket();
  }

  private async startInner(target: CdpTarget): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.closeSocket();
    await bootstrapAgentBrowserStream(target, this.agentBrowserSessionId, this.port);
    if (this.stopped) return;
    this.ws = await connectAgentBrowserStream(this.port);
    this.bindStream(this.ws);
  }

  private bindStream(ws: WebSocket): void {
    ws.on("message", (raw) => {
      const frame = parseAgentBrowserFrame(raw);
      if (!frame) return;
      if (estimateBase64Bytes(frame.data) > MAX_FRAME_PAYLOAD_BYTES) return;
      this.onFrame(frame);
    });
    ws.on("error", (err) => {
      if (this.stopped) return;
      this.onError(`agent-browser stream error: ${getErrorMessage(err)}`);
    });
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
    });
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    try {
      ws.close();
    } catch {
      // Best-effort; the agent-browser stream auto-stops when clients disconnect.
    }
  }
}

class BrowserProxySession {
  private client: CdpClient | null = null;
  private attachQueue: Promise<void> = Promise.resolve();
  private readonly stream: AgentBrowserStream;
  private readonly connectionIds = new Set<string>();
  private width = 1280;
  private height = 720;
  private isMobileView = false;
  private streamTransport: BrowserProxyStreamTransport = "frames";
  private currentUrl = "about:blank";
  private loading = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private inputTokens = INPUT_RATE_BURST;
  private inputRefillAt = Date.now();
  private lastFrameAt = 0;
  private lastForwardedFrameAt = 0;
  private screencastStarted = false;
  private readonly nativeCdpStream: boolean;

  constructor(
    readonly tabId: string,
    readonly workspaceId: string | undefined,
    private target: CdpTarget,
    private readonly ownsTarget: boolean,
    readonly streamPort: number,
    readonly agentBrowserSessionId: string
  ) {
    this.currentUrl = target.url || "about:blank";
    this.nativeCdpStream = usesNativeElectronCdp() && target.type === "webview";
    this.stream = new AgentBrowserStream(
      streamPort,
      agentBrowserSessionId,
      (frame) => {
        this.lastFrameAt = frame.timestamp;
        if (frame.timestamp - this.lastForwardedFrameAt < MIN_FRAME_INTERVAL_MS) return;
        this.lastForwardedFrameAt = frame.timestamp;
        this.emitFrame(frame.data, frame.width, frame.height, "jpeg", frame.timestamp);
      },
      (error) => this.emitError(error)
    );
  }

  async attach(params: BrowserProxyAttachParams, connectionId: string | undefined): Promise<void> {
    if (connectionId) this.connectionIds.add(connectionId);
    const next = this.attachQueue.then(
      () => this.attachInner(params),
      () => this.attachInner(params)
    );
    this.attachQueue = next.catch(() => {});
    return next;
  }

  requestNativeActivation(params: BrowserProxyAttachParams): void {
    const url = params.url || this.currentUrl;
    if (!usesNativeElectronCdp() || !params.workspaceId || isBlankUrl(url)) return;
    if (this.target.type !== "webview") return;
    emit("browser:nativeTabRequested", {
      tabId: this.tabId,
      workspaceId: params.workspaceId,
      url,
    });
  }

  private async attachInner(params: BrowserProxyAttachParams): Promise<void> {
    this.width = normalizeSize(params.width, MAX_STREAM_WIDTH);
    this.height = normalizeSize(params.height, MAX_STREAM_HEIGHT);
    this.isMobileView = params.isMobileView === true;
    this.streamTransport = normalizeStreamTransport(params.preferredTransport);

    await this.ensureClient();

    await this.setViewport();
    const shouldNavigate = !!params.url && params.url !== this.currentUrl;

    if (shouldNavigate && params.url) {
      await this.navigate(params.url);
    } else {
      await this.refreshState({ loading: false });
    }
    await this.startStream();
  }

  async detach(connectionId: string | undefined): Promise<void> {
    if (connectionId) this.connectionIds.delete(connectionId);
    if (!connectionId || this.connectionIds.size === 0) {
      this.stream.close();
      await this.stopNativeScreencast();
    }
  }

  hasConnection(connectionId: string): boolean {
    return this.connectionIds.has(connectionId);
  }

  removeConnection(connectionId: string): boolean {
    this.connectionIds.delete(connectionId);
    return this.connectionIds.size === 0;
  }

  async close(): Promise<void> {
    await this.stopNativeScreencast();
    this.stream.close();
    this.client?.close();
    this.client = null;
    claimedTargetIds.delete(this.target.id);
    sessions.delete(this.tabId);
    if (this.ownsTarget) {
      await closeTarget(this.target.id);
    }
  }

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.loading = true;
    this.emit("browser:state", {
      tabId: this.tabId,
      currentUrl: url,
      loading: true,
      error: null,
    });
    await this.sendCdp("Page.navigate", { url });
  }

  async goBack(): Promise<void> {
    const entryId = await this.getHistoryEntryId(-1);
    if (entryId === null) return;
    await this.sendCdp("Page.navigateToHistoryEntry", { entryId });
  }

  async goForward(): Promise<void> {
    const entryId = await this.getHistoryEntryId(1);
    if (entryId === null) return;
    await this.sendCdp("Page.navigateToHistoryEntry", { entryId });
  }

  async reload(): Promise<void> {
    if (this.target.type === "webview" && !isBlankUrl(this.currentUrl)) {
      await this.navigate(this.currentUrl);
      return;
    }

    this.loading = true;
    this.emit("browser:state", { tabId: this.tabId, loading: true, error: null });
    await this.sendCdp("Page.reload", { ignoreCache: false });
  }

  async resize(params: BrowserProxyResizeParams): Promise<void> {
    this.width = normalizeSize(params.width, MAX_STREAM_WIDTH);
    this.height = normalizeSize(params.height, MAX_STREAM_HEIGHT);
    this.isMobileView = params.isMobileView === true;
    this.streamTransport = normalizeStreamTransport(params.preferredTransport);
    await this.setViewport(await this.ensureClient());
    await this.startStream();
  }

  async input(params: BrowserProxyInputParams): Promise<void> {
    if (!this.takeInputToken()) return;
    if (this.nativeCdpStream) {
      await this.dispatchCdpInput(params);
      return;
    }
    this.stream.sendInput(params);
  }

  queueInput(params: BrowserProxyInputParams): void {
    const run = () => this.input(params);
    this.inputQueue = this.inputQueue.then(run, run).catch((err) => {
      this.emitError(getErrorMessage(err));
    });
  }

  async evaluate(params: BrowserProxyEvalParams): Promise<unknown> {
    const result = (await this.sendCdp("Runtime.evaluate", {
      expression: params.expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown; unserializableValue?: string };
      exceptionDetails?: unknown;
    };

    if (result.exceptionDetails) {
      throw new Error("Browser evaluation threw an exception");
    }
    return result.result?.value ?? result.result?.unserializableValue ?? null;
  }

  async captureScreenshot(params: BrowserProxyScreenshotParams): Promise<string> {
    const clip = params.rect
      ? {
          x: Math.max(0, params.rect.x),
          y: Math.max(0, params.rect.y),
          width: Math.max(MIN_VIEWPORT_SIZE, params.rect.width),
          height: Math.max(MIN_VIEWPORT_SIZE, params.rect.height),
          scale: 1,
        }
      : undefined;
    const result = (await this.sendCdp("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip } : {}),
    })) as { data?: string };
    if (!result.data) throw new Error("Screenshot capture returned no data");
    return `data:image/png;base64,${result.data}`;
  }

  private requireClient(): CdpClient {
    if (!this.client) throw new Error("Browser proxy tab is not attached");
    return this.client;
  }

  private async sendCdp(method: string, params: JsonObject = {}): Promise<unknown> {
    try {
      return await (await this.ensureClient()).send(method, params);
    } catch (err) {
      if (!isCdpDisconnectError(err)) throw err;
      this.client?.close();
      return await (await this.ensureClient()).send(method, params);
    }
  }

  private async ensureClient(): Promise<CdpClient> {
    if (this.client?.isOpen()) return this.client;

    const hadClient = this.client !== null;
    this.client?.close();
    this.client = null;
    this.screencastStarted = false;

    const target = hadClient ? await this.resolveTargetAfterDisconnect() : this.target;
    if (!target.webSocketDebuggerUrl) throw new Error("CDP target has no debugger URL");
    if (target.id !== this.target.id) {
      claimedTargetIds.delete(this.target.id);
      claimedTargetIds.add(target.id);
    }
    this.target = target;

    this.client = await CdpClient.connect(target.webSocketDebuggerUrl);
    this.bindEvents();
    await this.enableDomains();
    await this.setViewport(this.client);
    return this.client;
  }

  private async resolveTargetAfterDisconnect(): Promise<CdpTarget> {
    const deadline = Date.now() + TARGET_RECONNECT_TIMEOUT_MS;
    do {
      const registered = await findRegisteredTarget(this.tabId);
      if (registered) return registered;

      const byId = await findTargetById(this.target.id);
      if (byId && isUsablePageTarget(byId)) return byId;

      const byUrl = await findTargetByUrl(this.currentUrl);
      if (byUrl) return byUrl;

      if (Date.now() < deadline) {
        await delay(TARGET_RECONNECT_POLL_MS);
      }
    } while (Date.now() < deadline);

    throw new Error("CDP target disappeared");
  }

  private async enableDomains(): Promise<void> {
    const client = this.requireClient();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable").catch(() => {});
  }

  private bindEvents(): void {
    const client = this.requireClient();
    client.on("Page.frameStartedLoading", () => {
      this.loading = true;
      this.emit("browser:state", { tabId: this.tabId, loading: true, error: null });
    });

    client.on("Page.frameNavigated", (params) => {
      const frame = (params.frame ?? {}) as JsonObject;
      if (typeof frame.parentId === "string") return;
      const url = asString(frame.url);
      if (!url || url === "about:blank") return;
      this.currentUrl = url;
      this.emit("browser:state", { tabId: this.tabId, currentUrl: url, title: titleFromUrl(url) });
    });

    client.on("Page.loadEventFired", () => {
      void (async () => {
        await this.refreshState({ loading: false });
      })().catch((err) => {
        this.emitError(getErrorMessage(err));
      });
    });

    client.on("Runtime.consoleAPICalled", (params) => {
      const type = asString(params.type) ?? "log";
      const args = Array.isArray(params.args) ? params.args : [];
      this.emit("browser:console", {
        tabId: this.tabId,
        level: consoleLevel(type),
        message: args.map(remoteObjectToString).join(" "),
      });
    });

    client.on("Log.entryAdded", (params) => {
      const entry = (params.entry ?? {}) as JsonObject;
      const text = asString(entry.text);
      if (!text) return;
      this.emit("browser:console", {
        tabId: this.tabId,
        level: consoleLevel(asString(entry.level) ?? "info"),
        message: text,
      });
    });

    client.on("Page.screencastFrame", (params) => {
      if (!this.nativeCdpStream) return;
      const data = asString(params.data);
      if (!data) return;
      const sessionId = asNumber(params.sessionId);
      if (sessionId !== undefined) {
        client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      }
      if (estimateBase64Bytes(data) > MAX_FRAME_PAYLOAD_BYTES) return;
      const metadata =
        params.metadata && typeof params.metadata === "object"
          ? (params.metadata as JsonObject)
          : {};
      const timestamp = Date.now();
      this.lastFrameAt = timestamp;
      if (timestamp - this.lastForwardedFrameAt < MIN_FRAME_INTERVAL_MS) return;
      this.lastForwardedFrameAt = timestamp;
      this.emitFrame(
        data,
        asNumber(metadata.deviceWidth) ?? this.streamWidth(),
        asNumber(metadata.deviceHeight) ?? this.streamHeight(),
        "jpeg",
        timestamp
      );
    });
  }

  private async refreshState(patch: Partial<BrowserProxyStateEvent> = {}): Promise<void> {
    this.loading = patch.loading ?? this.loading;
    const title = await this.getTitle().catch(() => titleFromUrl(this.currentUrl));
    this.emit("browser:state", {
      tabId: this.tabId,
      currentUrl: this.currentUrl,
      title,
      loading: this.loading,
      error: null,
      ...patch,
    });
  }

  private async getTitle(): Promise<string> {
    const result = (await this.sendCdp("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return typeof result.result?.value === "string"
      ? result.result.value
      : titleFromUrl(this.currentUrl);
  }

  private async getHistoryEntryId(offset: -1 | 1): Promise<number | null> {
    const result = (await this.sendCdp("Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: Array<{ id: number }>;
    };
    const entries = result.entries ?? [];
    const nextIndex = (result.currentIndex ?? 0) + offset;
    return entries[nextIndex]?.id ?? null;
  }

  private async setViewport(client = this.requireClient()): Promise<void> {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: this.streamWidth(),
      height: this.streamHeight(),
      deviceScaleFactor: this.isMobileView ? MOBILE_PREVIEW_DPR : 1,
      mobile: this.isMobileView,
    });
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: this.isMobileView,
      ...(this.isMobileView ? { maxTouchPoints: 5 } : {}),
    });
  }

  private async startStream(): Promise<void> {
    const client = await this.ensureClient();
    await client.send("Page.bringToFront").catch(() => {});
    if (this.streamTransport === "webrtc") {
      this.stream.close();
      await this.stopNativeScreencast();
      return;
    }
    if (this.nativeCdpStream) {
      await this.restartNativeScreencast(client);
      return;
    }
    await this.stream.start(this.target);
  }

  private async restartNativeScreencast(client = this.requireClient()): Promise<void> {
    if (!this.nativeCdpStream) return;
    if (this.screencastStarted) {
      await client.send("Page.stopScreencast").catch(() => {});
      this.screencastStarted = false;
    }
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      everyNthFrame: 1,
    });
    this.screencastStarted = true;
  }

  private async stopNativeScreencast(): Promise<void> {
    if (!this.nativeCdpStream) return;
    if (!this.screencastStarted) return;
    const client = this.client;
    this.screencastStarted = false;
    if (!client?.isOpen()) return;
    await client.send("Page.stopScreencast").catch(() => {});
  }

  private async dispatchCdpInput(params: BrowserProxyInputParams): Promise<void> {
    if (params.kind === "mouse") {
      await this.sendCdp("Input.dispatchMouseEvent", {
        type: params.type,
        x: params.x,
        y: params.y,
        button: params.button,
        clickCount: params.clickCount ?? 0,
        modifiers: params.modifiers ?? 0,
      });
      return;
    }

    if (params.kind === "wheel") {
      await this.sendCdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: params.x,
        y: params.y,
        deltaX: params.deltaX,
        deltaY: params.deltaY,
        modifiers: params.modifiers ?? 0,
      });
      return;
    }

    if (params.kind === "key") {
      await this.sendCdp("Input.dispatchKeyEvent", {
        type: params.type,
        key: params.key,
        code: params.code,
        ...(params.type === "keyDown" && params.text ? { text: params.text } : {}),
        modifiers: params.modifiers ?? 0,
      });
      if (params.type === "keyDown" && params.text) {
        await this.sendCdp("Input.dispatchKeyEvent", {
          type: "char",
          key: params.key,
          code: params.code,
          text: params.text,
          unmodifiedText: params.text,
          modifiers: params.modifiers ?? 0,
        });
      }
      return;
    }

    await this.sendCdp("Input.dispatchTouchEvent", {
      type: params.type,
      touchPoints: params.touchPoints,
      modifiers: params.modifiers ?? 0,
    });
  }

  private emitFrame(
    data: string,
    width: number,
    height: number,
    format: BrowserProxyFrameEvent["format"] = "jpeg",
    timestamp = Date.now()
  ): void {
    this.emit(
      "browser:frame",
      {
        tabId: this.tabId,
        data,
        format,
        width: normalizeSize(width, MAX_STREAM_WIDTH),
        height: normalizeSize(height, MAX_STREAM_HEIGHT),
        timestamp,
      },
      { maxBufferedAmount: MAX_FRAME_BUFFERED_AMOUNT }
    );
  }

  private emitError(error: string): void {
    this.emit("browser:error", { tabId: this.tabId, error });
  }

  private emit(
    event: "browser:frame",
    data: BrowserProxyFrameEvent,
    options?: { maxBufferedAmount?: number }
  ): void;
  private emit(event: "browser:state", data: BrowserProxyStateEvent): void;
  private emit(event: "browser:console", data: BrowserProxyConsoleEvent): void;
  private emit(event: "browser:error", data: BrowserProxyErrorEvent): void;
  private emit(event: string, data: unknown, options: { maxBufferedAmount?: number } = {}): void {
    const payload = JSON.stringify({ type: "q:event", event, data });
    if (this.connectionIds.size === 0) {
      wsBroadcast(payload, options);
      return;
    }
    for (const connectionId of this.connectionIds) {
      sendToConnection(connectionId, payload, options);
    }
  }

  private takeInputToken(): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.inputRefillAt) / 1000;
    if (elapsedSeconds > 0) {
      this.inputTokens = Math.min(
        INPUT_RATE_BURST,
        this.inputTokens + elapsedSeconds * INPUT_RATE_PER_SECOND
      );
      this.inputRefillAt = now;
    }
    if (this.inputTokens < 1) return false;
    this.inputTokens -= 1;
    return true;
  }

  private streamWidth(): number {
    return this.isMobileView ? MOBILE_PREVIEW_WIDTH : this.width;
  }

  private streamHeight(): number {
    return this.height;
  }
}

function toAgentBrowserInput(params: BrowserProxyInputParams): JsonObject {
  if (params.kind === "mouse") {
    return {
      type: "input_mouse",
      eventType: params.type,
      x: params.x,
      y: params.y,
      button: params.button,
      clickCount: params.clickCount ?? 0,
      modifiers: params.modifiers ?? 0,
    };
  }
  if (params.kind === "wheel") {
    return {
      type: "input_mouse",
      eventType: "mouseWheel",
      x: params.x,
      y: params.y,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
      modifiers: params.modifiers ?? 0,
    };
  }
  if (params.kind === "touch") {
    return {
      type: "input_touch",
      eventType: params.type,
      touchPoints: params.touchPoints,
      modifiers: params.modifiers ?? 0,
    };
  }
  return {
    type: "input_keyboard",
    eventType: params.type,
    key: params.key,
    code: params.code,
    text: params.text,
    modifiers: params.modifiers ?? 0,
  };
}

function parseAgentBrowserFrame(raw: RawData): AgentBrowserStreamFrame | null {
  let msg: JsonObject;
  try {
    msg = JSON.parse(raw.toString()) as JsonObject;
  } catch {
    return null;
  }
  if (msg.type !== "frame" || typeof msg.data !== "string") return null;
  const metadata =
    msg.metadata && typeof msg.metadata === "object" ? (msg.metadata as JsonObject) : {};
  return {
    data: msg.data,
    width: normalizeSize(asNumber(metadata.deviceWidth) ?? 1280, MAX_STREAM_WIDTH),
    height: normalizeSize(asNumber(metadata.deviceHeight) ?? 720, MAX_STREAM_HEIGHT),
    timestamp: Date.now(),
  };
}

function estimateBase64Bytes(value: string): number {
  return Math.floor(value.length * 0.75);
}

async function bootstrapAgentBrowserStream(
  target: CdpTarget,
  sessionId: string,
  port: number
): Promise<void> {
  if (!target.webSocketDebuggerUrl) throw new Error("CDP target has no debugger URL");
  const env = {
    ...process.env,
    AGENT_BROWSER_SESSION: sessionId,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(AGENT_BROWSER_IDLE_TIMEOUT_MS),
    AGENT_BROWSER_STREAM_PORT: String(port),
    AGENT_BROWSER_SOCKET_DIR: process.env.AGENT_BROWSER_SOCKET_DIR ?? "/tmp",
  };

  const browserWsUrl = await getBrowserWsUrl();
  if (!browserWsUrl) {
    await runAgentBrowserCommand(
      ["--cdp", target.webSocketDebuggerUrl, "get", "url", "--json"],
      env
    );
    return;
  }

  const tabIndex = await resolveAgentBrowserTabIndex(browserWsUrl, target, env);
  const selected = await runAgentBrowserCommand(
    ["--cdp", browserWsUrl, "tab", String(tabIndex), "--json"],
    env
  );
  assertAgentBrowserSelectedTarget(selected, target);
}

async function resolveAgentBrowserTabIndex(
  cdpUrl: string,
  target: CdpTarget,
  env: Record<string, string | undefined>
): Promise<number> {
  const result = await runAgentBrowserCommand(["--cdp", cdpUrl, "tab", "list", "--json"], env);
  const tabs = getAgentBrowserTabs(result);
  const exactMatches = tabs.filter((tab) => agentBrowserTabMatchesTarget(tab, target, true));
  const exactIndex = await pickAgentBrowserTabIndex(target, exactMatches, true);
  if (exactIndex !== null) return exactIndex;

  const urlMatches = tabs.filter((tab) => agentBrowserTabMatchesTarget(tab, target, false));
  const urlIndex = await pickAgentBrowserTabIndex(target, urlMatches, false);
  if (urlIndex !== null) return urlIndex;

  throw new Error(
    `agent-browser could not resolve CDP target tab: ${target.id} ${target.type} ${
      target.url ?? "about:blank"
    }`
  );
}

async function pickAgentBrowserTabIndex(
  target: CdpTarget,
  matches: AgentBrowserTab[],
  requireType: boolean
): Promise<number | null> {
  const indexedMatches = matches.filter(
    (tab): tab is AgentBrowserTab & { index: number } => typeof tab.index === "number"
  );
  if (indexedMatches.length === 1) return indexedMatches[0].index;
  if (indexedMatches.length < 2) return null;

  const cdpOrdinal = await getCdpTargetOrdinal(target, requireType);
  return cdpOrdinal !== null ? (indexedMatches[cdpOrdinal]?.index ?? null) : null;
}

async function getCdpTargetOrdinal(
  target: CdpTarget,
  requireType: boolean
): Promise<number | null> {
  const targets = await listTargets().catch(() => []);
  const matchingTargets = targets.filter(
    (candidate) =>
      isUsablePageTarget(candidate) &&
      cdpTargetMatchesAgentBrowserMatch(candidate, target, requireType)
  );
  const ordinal = matchingTargets.findIndex((candidate) => candidate.id === target.id);
  return ordinal >= 0 ? ordinal : null;
}

function cdpTargetMatchesAgentBrowserMatch(
  candidate: CdpTarget,
  target: CdpTarget,
  requireType: boolean
): boolean {
  if (typeof target.url === "string" && candidate.url !== target.url) return false;
  if (requireType && target.type && candidate.type !== target.type) return false;
  if (target.title && candidate.title && candidate.title !== target.title) return false;
  return !!target.url;
}

function getAgentBrowserTabs(result: AgentBrowserCommandResult): AgentBrowserTab[] {
  const data = result.data;
  if (!data || typeof data !== "object") return [];
  const tabs = (data as JsonObject).tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.filter((tab): tab is AgentBrowserTab => !!tab && typeof tab === "object");
}

function agentBrowserTabMatchesTarget(
  tab: AgentBrowserTab,
  target: CdpTarget,
  requireType: boolean
): boolean {
  if (typeof tab.index !== "number") return false;
  if (target.url && tab.url !== target.url) return false;
  if (requireType && target.type && tab.type !== target.type) return false;
  if (target.title && tab.title && tab.title !== target.title) return false;
  return !!target.url;
}

function assertAgentBrowserSelectedTarget(
  result: AgentBrowserCommandResult,
  target: CdpTarget
): void {
  const data = result.data;
  if (!data || typeof data !== "object") return;
  const selectedUrl = asString((data as JsonObject).url);
  if (!selectedUrl || !target.url || selectedUrl === target.url) return;
  throw new Error(`agent-browser selected wrong CDP target: ${selectedUrl} !== ${target.url}`);
}

async function runAgentBrowserCommand(
  args: string[],
  env: Record<string, string | undefined>
): Promise<AgentBrowserCommandResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      AGENT_BROWSER_BINARY,
      args,
      { env, timeout: AGENT_BROWSER_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || stdout || err.message));
          return;
        }
        resolve(stdout);
      }
    );
    child.on("error", reject);
  });

  if (!stdout.trim()) return { success: true };

  let parsed: AgentBrowserCommandResult;
  try {
    parsed = JSON.parse(stdout) as AgentBrowserCommandResult;
  } catch {
    return { success: true, data: stdout };
  }

  if (parsed.success === false) {
    throw new Error(`agent-browser command failed: ${stringifyAgentBrowserError(parsed.error)}`);
  }
  return parsed;
}

function stringifyAgentBrowserError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function connectAgentBrowserStream(port: number): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}`;
  const deadline = Date.now() + AGENT_BROWSER_STREAM_CONNECT_TIMEOUT_MS;
  let lastError: unknown = null;
  do {
    try {
      return await openStreamSocket(url);
    } catch (err) {
      lastError = err;
      await delay(AGENT_BROWSER_STREAM_CONNECT_POLL_MS);
    }
  } while (Date.now() < deadline);
  throw new Error(`agent-browser stream did not open: ${getErrorMessage(lastError)}`);
}

function openStreamSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("stream socket closed before opening"));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function allocateStreamPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Failed to allocate agent-browser stream port"));
      });
    });
  });
}

function makeAgentBrowserSessionId(tabId: string): string {
  const tabHash = createHash("sha256").update(tabId).digest("hex").slice(0, 8);
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  return `deus-${tabHash}-${nonce}`;
}

export async function attachBrowserTab(
  params: BrowserProxyAttachParams,
  connectionId?: string
): Promise<void> {
  let session = sessions.get(params.tabId);
  const hadSession = !!session;
  if (!session) {
    let pending = pendingSessionCreates.get(params.tabId);
    if (!pending) {
      pending = createSession(params.tabId, params.workspaceId, params.url).finally(() => {
        pendingSessionCreates.delete(params.tabId);
      });
      pendingSessionCreates.set(params.tabId, pending);
    }
    session = await pending;
  }
  if (hadSession) session.requestNativeActivation(params);
  await session.attach(params, connectionId);
}

async function createSession(
  tabId: string,
  workspaceId: string | undefined,
  url: string | undefined
): Promise<BrowserProxySession> {
  let registered = await findRegisteredTarget(tabId);
  if (!registered && usesNativeElectronCdp() && workspaceId && !isBlankUrl(url)) {
    registered = await requestNativeTabTarget(tabId, workspaceId, url);
  }

  const allowUrlFallback = !usesNativeElectronCdp() || !workspaceId;
  const existing = registered ?? (allowUrlFallback ? await findTargetByUrl(url) : null);
  const ownsTarget = !existing;
  const target = existing ?? (await createTarget(url));
  if (!target.webSocketDebuggerUrl) throw new Error("CDP target has no debugger URL");
  claimedTargetIds.add(target.id);
  const streamPort = await allocateStreamPort();
  const session = new BrowserProxySession(
    tabId,
    workspaceId,
    target,
    ownsTarget,
    streamPort,
    makeAgentBrowserSessionId(tabId)
  );
  sessions.set(tabId, session);
  return session;
}

async function requestNativeTabTarget(
  tabId: string,
  workspaceId: string,
  url: string | undefined
): Promise<CdpTarget | null> {
  const requestedUrl = url;
  if (!requestedUrl || requestedUrl === "about:blank") return null;

  emit("browser:nativeTabRequested", { tabId, workspaceId, url: requestedUrl });

  const deadline = Date.now() + nativeTabRequestTimeoutMs();
  while (Date.now() < deadline) {
    const target = await findRegisteredTarget(tabId);
    if (target) return target;
    await delay(NATIVE_TAB_REQUEST_POLL_MS);
  }

  return null;
}

function requestNativeTabClose(tabId: string, workspaceId: string | undefined): void {
  const payload = workspaceId ? { tabId, workspaceId } : { tabId };
  emit("browser:nativeTabCloseRequested", payload);
}

async function findRegisteredTarget(tabId: string): Promise<CdpTarget | null> {
  const registrations: NativeTabRegistration[] = [];
  const exact = nativeTabRegistrations.get(tabId);
  if (exact) registrations.push(exact);

  for (const registration of registrations) {
    const target = await findTargetForRegistration(registration);
    if (target) return target;
  }
  return null;
}

async function findTargetForRegistration(
  registration: NativeTabRegistration
): Promise<CdpTarget | null> {
  const targets = (await listTargets()).filter(
    (target) => isUsablePageTarget(target) && !claimedTargetIds.has(target.id)
  );
  if (targets.length === 0) return null;

  const urlMatches = targets.filter((target) => targetMatchesRegistrationUrl(target, registration));
  const orderedTargets = [
    ...urlMatches,
    ...targets.filter((target) => !urlMatches.includes(target)),
  ];

  for (const target of orderedTargets) {
    if (await targetHasNativeTabMarker(target, registration.tabId)) {
      return target;
    }
  }

  return urlMatches.length === 1 ? urlMatches[0] : null;
}

function targetMatchesRegistrationUrl(
  target: CdpTarget,
  registration: NativeTabRegistration
): boolean {
  if (isBlankUrl(registration.url)) return isBlankUrl(target.url);
  return target.url === registration.url;
}

async function targetHasNativeTabMarker(target: CdpTarget, tabId: string): Promise<boolean> {
  if (!target.webSocketDebuggerUrl) return false;
  let client: CdpClient | null = null;
  try {
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const result = (await client.send("Runtime.evaluate", {
      expression: `globalThis.${NATIVE_TAB_MARKER}`,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return result.result?.value === tabId;
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

export function registerNativeBrowserTab(params: BrowserProxyNativeTabParams): void {
  nativeTabRegistrations.set(params.tabId, {
    tabId: params.tabId,
    workspaceId: params.workspaceId,
    url: params.url,
  });
}

export function unregisterNativeBrowserTab(params: BrowserProxyTabParams): void {
  nativeTabRegistrations.delete(params.tabId);
}

export async function detachBrowserTab(
  params: BrowserProxyTabParams,
  connectionId?: string
): Promise<void> {
  const session = sessions.get(params.tabId) ?? (await pendingSessionCreates.get(params.tabId));
  await session?.detach(connectionId);
}

export async function closeBrowserTab(params: BrowserProxyTabParams): Promise<void> {
  const registration = nativeTabRegistrations.get(params.tabId);
  const session = sessions.get(params.tabId) ?? (await pendingSessionCreates.get(params.tabId));
  await session?.close();
  if (usesNativeElectronCdp() && registration) {
    requestNativeTabClose(params.tabId, registration.workspaceId);
  }
}

export function cleanupBrowserSessionsForConnection(connectionId: string): void {
  for (const [tabId, session] of sessions) {
    if (!session.hasConnection(connectionId)) continue;
    if (!session.removeConnection(connectionId)) continue;
    void closeBrowserTab({ tabId }).catch((err) => {
      emit("browser:error", { tabId, error: getErrorMessage(err) });
    });
  }
}

export async function navigateBrowserTab(params: BrowserProxyNavigateParams): Promise<void> {
  await requireSession(params.tabId).navigate(params.url);
}

export async function goBackBrowserTab(params: BrowserProxyTabParams): Promise<void> {
  await requireSession(params.tabId).goBack();
}

export async function goForwardBrowserTab(params: BrowserProxyTabParams): Promise<void> {
  await requireSession(params.tabId).goForward();
}

export async function reloadBrowserTab(params: BrowserProxyTabParams): Promise<void> {
  await requireSession(params.tabId).reload();
}

export async function resizeBrowserTab(params: BrowserProxyResizeParams): Promise<void> {
  await requireSession(params.tabId).resize(params);
}

export function sendBrowserInput(params: BrowserProxyInputParams): void {
  requireSession(params.tabId).queueInput(params);
}

export async function evaluateBrowserTab(params: BrowserProxyEvalParams): Promise<unknown> {
  return requireSession(params.tabId).evaluate(params);
}

export async function captureBrowserScreenshot(
  params: BrowserProxyScreenshotParams
): Promise<string> {
  return requireSession(params.tabId).captureScreenshot(params);
}

export function relayBrowserWebRtcOffer(params: BrowserProxyWebRtcDescriptionEvent): void {
  emit("browser:webrtcOffer", params);
}

export function relayBrowserWebRtcAnswer(params: BrowserProxyWebRtcDescriptionEvent): void {
  emit("browser:webrtcAnswer", params);
}

export function relayBrowserWebRtcIce(params: BrowserProxyWebRtcIceCandidateEvent): void {
  emit("browser:webrtcIce", params);
}

export function relayBrowserWebRtcStop(params: BrowserProxyWebRtcStopEvent): void {
  emit("browser:webrtcStop", params);
}

function requireSession(tabId: string): BrowserProxySession {
  const session = sessions.get(tabId);
  if (!session) throw new Error(`Browser proxy tab is not attached: ${tabId}`);
  return session;
}

onConnectionRemoved((connectionId) => {
  cleanupBrowserSessionsForConnection(connectionId);
});

function normalizeSize(value: number, max = Number.MAX_SAFE_INTEGER): number {
  return Math.min(max, Math.max(MIN_VIEWPORT_SIZE, Math.floor(value || MIN_VIEWPORT_SIZE)));
}

function normalizeStreamTransport(
  transport: BrowserProxyStreamTransport | undefined
): BrowserProxyStreamTransport {
  return transport === "webrtc" ? "webrtc" : "frames";
}

function nativeTabRequestTimeoutMs(): number {
  const configured = Number(process.env.BROWSER_PROXY_NATIVE_TAB_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 12_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consoleLevel(level: string): BrowserProxyConsoleEvent["level"] {
  if (level === "error" || level === "assert") return "error";
  if (level === "warning" || level === "warn") return "warn";
  if (level === "debug" || level === "verbose") return "debug";
  return "info";
}

function remoteObjectToString(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const obj = value as JsonObject;
  if (typeof obj.value === "string") return obj.value;
  if (obj.value !== undefined) return String(obj.value);
  if (typeof obj.description === "string") return obj.description;
  return JSON.stringify(obj);
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return "New Tab";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "New Tab";
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCdpDisconnectError(err: unknown): boolean {
  const message = getErrorMessage(err);
  return message === "CDP socket closed" || message === "CDP socket is not open";
}
