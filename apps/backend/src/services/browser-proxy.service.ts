// backend/src/services/browser-proxy.service.ts
// Browser streaming for hosted web clients.
//
// The hosted frontend cannot mount a native browser engine. Instead it asks the
// backend to run the page in local managed Chrome and stream frames over the
// existing WebSocket relay.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { broadcast as wsBroadcast, onConnectionRemoved, sendToConnection } from "./ws.service";
import { getManagedBrowserCdpBaseUrl } from "./managed-browser.service";
import { AgentBrowserStream } from "./browser-proxy/agent-browser-stream";
import {
  CdpClient,
  claimTarget,
  closeTarget,
  createTarget,
  findTargetById,
  findTargetByUrl,
  getNativeCdpBaseUrl,
  isUsablePageTarget,
  replaceClaimedTarget,
  type CdpTarget,
  type JsonObject,
  unclaimTarget,
} from "./browser-proxy/cdp";
import type {
  BrowserProxyAttachParams,
  BrowserProxyConsoleEvent,
  BrowserProxyErrorEvent,
  BrowserProxyEvalParams,
  BrowserProxyFrameEvent,
  BrowserProxyInputParams,
  BrowserProxyNavigateParams,
  BrowserProxyResizeParams,
  BrowserProxyScreenshotParams,
  BrowserProxyStateEvent,
  BrowserProxyTabParams,
} from "@shared/types/browser-proxy";

const MAX_STREAM_WIDTH = 1920;
const MAX_STREAM_HEIGHT = 1080;
const MAX_FRAME_BUFFERED_AMOUNT = 1_000_000;
const MIN_FRAME_INTERVAL_MS = 66;
const INPUT_RATE_PER_SECOND = 120;
const INPUT_RATE_BURST = 180;
const MIN_VIEWPORT_SIZE = 1;
const MOBILE_PREVIEW_WIDTH = 390;
const MOBILE_PREVIEW_DPR = 3;
const TARGET_RECONNECT_TIMEOUT_MS = 8_000;
const TARGET_RECONNECT_POLL_MS = 100;

function emit(event: "browser:frame", data: BrowserProxyFrameEvent): void;
function emit(event: "browser:state", data: BrowserProxyStateEvent): void;
function emit(event: "browser:console", data: BrowserProxyConsoleEvent): void;
function emit(event: "browser:error", data: BrowserProxyErrorEvent): void;
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

function isHttpUrl(url: string | undefined): boolean {
  if (isBlankUrl(url)) return false;
  const candidate = url;
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function resolveBrowserEngineCdpBaseUrl(url: string | undefined): Promise<string> {
  if (process.env.BROWSER_CDP_URL) return getNativeCdpBaseUrl();
  return isHttpUrl(url) ? await getManagedBrowserCdpBaseUrl() : getNativeCdpBaseUrl();
}

const sessions = new Map<string, BrowserProxySession>();
const pendingSessionCreates = new Map<string, Promise<BrowserProxySession>>();

class BrowserProxySession {
  private client: CdpClient | null = null;
  private attachQueue: Promise<void> = Promise.resolve();
  private readonly stream: AgentBrowserStream;
  private readonly connectionIds = new Set<string>();
  private width = 1280;
  private height = 720;
  private isMobileView = false;
  private currentUrl = "about:blank";
  private loading = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private inputTokens = INPUT_RATE_BURST;
  private inputRefillAt = Date.now();
  private lastFrameAt = 0;
  private lastForwardedFrameAt = 0;

  constructor(
    readonly tabId: string,
    readonly workspaceId: string | undefined,
    private target: CdpTarget,
    private readonly ownsTarget: boolean,
    readonly streamPort: number,
    readonly agentBrowserSessionId: string,
    private readonly cdpBaseUrl: string
  ) {
    this.currentUrl = target.url || "about:blank";
    this.stream = new AgentBrowserStream(
      streamPort,
      agentBrowserSessionId,
      cdpBaseUrl,
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

  private async attachInner(params: BrowserProxyAttachParams): Promise<void> {
    this.width = normalizeSize(params.width, MAX_STREAM_WIDTH);
    this.height = normalizeSize(params.height, MAX_STREAM_HEIGHT);
    this.isMobileView = params.isMobileView === true;

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
    this.stream.close();
    this.client?.close();
    this.client = null;
    unclaimTarget(this.target.id);
    sessions.delete(this.tabId);
    if (this.ownsTarget) {
      await closeTarget(this.target.id, this.cdpBaseUrl);
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
    this.loading = true;
    this.emit("browser:state", { tabId: this.tabId, loading: true, error: null });
    await this.sendCdp("Page.reload", { ignoreCache: false });
  }

  async resize(params: BrowserProxyResizeParams): Promise<void> {
    this.width = normalizeSize(params.width, MAX_STREAM_WIDTH);
    this.height = normalizeSize(params.height, MAX_STREAM_HEIGHT);
    this.isMobileView = params.isMobileView === true;
    await this.setViewport(await this.ensureClient());
    await this.startStream();
  }

  async input(params: BrowserProxyInputParams): Promise<void> {
    if (!this.takeInputToken()) return;
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

    const target = hadClient ? await this.resolveTargetAfterDisconnect() : this.target;
    if (!target.webSocketDebuggerUrl) throw new Error("CDP target has no debugger URL");
    if (target.id !== this.target.id) {
      replaceClaimedTarget(this.target.id, target.id);
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
      const byId = await findTargetById(this.target.id, this.cdpBaseUrl);
      if (byId && isUsablePageTarget(byId)) return byId;

      const byUrl = await findTargetByUrl(this.currentUrl, this.cdpBaseUrl);
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
    await this.stream.start(this.target);
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
  await session.attach(params, connectionId);
}

async function createSession(
  tabId: string,
  workspaceId: string | undefined,
  url: string | undefined
): Promise<BrowserProxySession> {
  const cdpBaseUrl = await resolveBrowserEngineCdpBaseUrl(url);
  const existing = await findTargetByUrl(url, cdpBaseUrl);
  const ownsTarget = !existing;
  const target = existing ?? (await createTarget(url, cdpBaseUrl));
  if (!target.webSocketDebuggerUrl) throw new Error("CDP target has no debugger URL");
  claimTarget(target.id);
  const streamPort = await allocateStreamPort();
  const session = new BrowserProxySession(
    tabId,
    workspaceId,
    target,
    ownsTarget,
    streamPort,
    makeAgentBrowserSessionId(tabId),
    cdpBaseUrl
  );
  sessions.set(tabId, session);
  return session;
}

export async function detachBrowserTab(
  params: BrowserProxyTabParams,
  connectionId?: string
): Promise<void> {
  const session = sessions.get(params.tabId) ?? (await pendingSessionCreates.get(params.tabId));
  await session?.detach(connectionId);
}

export async function closeBrowserTab(params: BrowserProxyTabParams): Promise<void> {
  const session = sessions.get(params.tabId) ?? (await pendingSessionCreates.get(params.tabId));
  await session?.close();
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
