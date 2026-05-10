import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { WebSocket, type RawData } from "ws";
import type { BrowserProxyInputParams } from "@shared/types/browser-proxy";
import {
  CdpClient,
  getBrowserWsUrl,
  isUsablePageTarget,
  listTargets,
  type CdpTarget,
  type JsonObject,
} from "./cdp";

export interface AgentBrowserStreamFrame {
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

const require = createRequire(import.meta.url);

const AGENT_BROWSER_COMMAND_TIMEOUT_MS = 10_000;
const AGENT_BROWSER_IDLE_TIMEOUT_MS = 30_000;
const AGENT_BROWSER_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const AGENT_BROWSER_STREAM_CONNECT_POLL_MS = 100;
const MAX_STREAM_WIDTH = 1920;
const MAX_STREAM_HEIGHT = 1080;
const MAX_FRAME_PAYLOAD_BYTES = 2_500_000;
const MIN_VIEWPORT_SIZE = 1;

const AGENT_BROWSER_BINARY = (() => {
  try {
    const pkgDir = dirname(require.resolve("agent-browser/package.json"));
    return join(pkgDir, "bin", "agent-browser.js");
  } catch {
    return "agent-browser";
  }
})();

export class AgentBrowserStream {
  private ws: WebSocket | null = null;
  private startQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly port: number,
    private readonly agentBrowserSessionId: string,
    private readonly cdpBaseUrl: string,
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
    await bootstrapAgentBrowserStream(
      target,
      this.agentBrowserSessionId,
      this.port,
      this.cdpBaseUrl
    );
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
  port: number,
  cdpBaseUrl: string
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

  const browserWsUrl = await getBrowserWsUrl(cdpBaseUrl);
  if (!browserWsUrl) {
    await runAgentBrowserCommand(
      ["--cdp", target.webSocketDebuggerUrl, "get", "url", "--json"],
      env
    );
    return;
  }

  const tabIndex = await resolveAgentBrowserTabIndex(browserWsUrl, target, env, cdpBaseUrl);
  const selected = await runAgentBrowserCommand(
    ["--cdp", browserWsUrl, "tab", String(tabIndex), "--json"],
    env
  );
  assertAgentBrowserSelectedTarget(selected, target);
}

async function resolveAgentBrowserTabIndex(
  cdpUrl: string,
  target: CdpTarget,
  env: Record<string, string | undefined>,
  cdpBaseUrl: string
): Promise<number> {
  const result = await runAgentBrowserCommand(["--cdp", cdpUrl, "tab", "list", "--json"], env);
  const tabs = getAgentBrowserTabs(result);
  const exactMatches = tabs.filter((tab) => agentBrowserTabMatchesTarget(tab, target, true));
  const exactIndex = await pickAgentBrowserTabIndex(target, exactMatches, true, cdpBaseUrl);
  if (exactIndex !== null) return exactIndex;

  const urlMatches = tabs.filter((tab) => agentBrowserTabMatchesTarget(tab, target, false));
  const urlIndex = await pickAgentBrowserTabIndex(target, urlMatches, false, cdpBaseUrl);
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
  requireType: boolean,
  cdpBaseUrl: string
): Promise<number | null> {
  const indexedMatches = matches.filter(
    (tab): tab is AgentBrowserTab & { index: number } => typeof tab.index === "number"
  );
  if (indexedMatches.length === 1) return indexedMatches[0].index;
  if (indexedMatches.length < 2) return null;

  const cdpOrdinal = await getCdpTargetOrdinal(target, requireType, cdpBaseUrl);
  return cdpOrdinal !== null ? (indexedMatches[cdpOrdinal]?.index ?? null) : null;
}

async function getCdpTargetOrdinal(
  target: CdpTarget,
  requireType: boolean,
  cdpBaseUrl: string
): Promise<number | null> {
  const targets = await listTargets(cdpBaseUrl).catch(() => []);
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

function normalizeSize(value: number, max = Number.MAX_SAFE_INTEGER): number {
  return Math.min(max, Math.max(MIN_VIEWPORT_SIZE, Math.floor(value || MIN_VIEWPORT_SIZE)));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
