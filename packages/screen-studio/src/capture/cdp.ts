import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ScreenStudioError } from "../errors.js";
import { remux } from "../util/ffmpeg.js";
import type { Size } from "../util/units.js";
import type { ActiveCapture, CaptureBackend, CaptureContext } from "./backend.js";
import { FramePump } from "./frame-pump.js";
import { observePage } from "./page-observer.js";

// ---------------------------------------------------------------------------
// Minimal DevTools protocol client
// ---------------------------------------------------------------------------

type Handler = (params: Record<string, unknown>) => void;

export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly handlers = new Map<string, Set<Handler>>();
  private closeHandlers: Array<(reason: string) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = (event) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("DevTools connection closed"));
      }
      this.pending.clear();
      const reason = event.reason || `connection closed (${event.code})`;
      for (const handler of this.closeHandlers) handler(reason);
    };
  }

  static connect(url: string, timeoutMs = 5_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new ScreenStudioError("source_unavailable", `Timed out connecting to ${url}`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(
          new ScreenStudioError("source_unavailable", `Could not connect to DevTools at ${url}`, {
            hint: "Check the browser is running with remote debugging and the target still exists.",
          })
        );
      };
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  on(method: string, handler: Handler): void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(handler);
    this.handlers.set(method, set);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.closeHandlers = [];
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "DevTools error"));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {});
    }
  }
}

// ---------------------------------------------------------------------------
// Target discovery
// ---------------------------------------------------------------------------

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Accepts what tools hand out: `http://host:port`, `host:port`, a bare port,
 * a browser WebSocket (`ws://…/devtools/browser/…`, e.g. `agent-browser get
 * cdp-url`) or a page WebSocket (`ws://…/devtools/page/<id>`).
 */
export function parseCdpEndpoint(endpoint: string): { http: string; pageWs?: string } {
  const value = endpoint.trim();
  if (/^\d+$/.test(value)) return { http: `http://127.0.0.1:${value}` };
  if (/^wss?:\/\//i.test(value)) {
    const url = new URL(value);
    const http = `${url.protocol === "wss:" ? "https" : "http"}://${url.host}`;
    return url.pathname.startsWith("/devtools/page/") ? { http, pageWs: value } : { http };
  }
  if (/^https?:\/\//i.test(value)) return { http: value.replace(/\/+$/, "") };
  if (/^[\w.-]+:\d+$/.test(value)) return { http: `http://${value}` };
  throw new ScreenStudioError("invalid_argument", `Not a DevTools endpoint: ${endpoint}`, {
    hint: "Use http://127.0.0.1:9222, a port, or a ws://…/devtools/… URL",
  });
}

export async function listCdpTargets(endpoint: string): Promise<CdpTarget[]> {
  const { http } = parseCdpEndpoint(endpoint);
  let response: Response;
  try {
    response = await fetch(`${http}/json/list`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new ScreenStudioError("source_unavailable", `No DevTools endpoint at ${http}`, {
      hint: "Start Chrome with --remote-debugging-port, or pass the URL from `agent-browser get cdp-url`.",
    });
  }
  const targets = (await response.json()) as Array<Partial<CdpTarget>>;
  return targets
    .filter(
      (t): t is CdpTarget => typeof t.webSocketDebuggerUrl === "string" && typeof t.id === "string"
    )
    .map((t) => ({
      id: t.id,
      type: t.type ?? "page",
      title: t.title ?? "",
      url: t.url ?? "",
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    }));
}

const INTERNAL_URL = /^(devtools|chrome|chrome-extension|chrome-untrusted|edge|about):/i;

/** Pick the tab to record. Prefers a URL match, then the first ordinary page. */
export async function resolvePageTarget(
  endpoint: string,
  options: { urlContains?: string; targetId?: string } = {}
): Promise<CdpTarget> {
  const parsed = parseCdpEndpoint(endpoint);
  const targets = await listCdpTargets(endpoint).catch((err) => {
    if (parsed.pageWs) return [] as CdpTarget[];
    throw err;
  });
  if (parsed.pageWs) {
    const match = targets.find((t) => t.webSocketDebuggerUrl === parsed.pageWs);
    return (
      match ?? {
        id: parsed.pageWs.split("/").pop() ?? "",
        type: "page",
        title: "",
        url: "",
        webSocketDebuggerUrl: parsed.pageWs,
      }
    );
  }
  // Electron <webview> guests (Deus's browser) are their own target type.
  const pages = targets.filter((t) => t.type === "page" || t.type === "webview");
  if (options.targetId) {
    const match = pages.find((t) => t.id === options.targetId);
    if (!match) throw notFound(endpoint, pages, `target ${options.targetId}`);
    return match;
  }
  if (options.urlContains) {
    const exact = pages.find((t) => t.url === options.urlContains);
    const partial = pages.filter((t) => t.url.includes(options.urlContains!));
    const match = exact ?? partial[0];
    if (!match)
      throw notFound(endpoint, pages, `a tab whose URL contains "${options.urlContains}"`);
    return match;
  }
  const ordinary = pages.filter((t) => !INTERNAL_URL.test(t.url));
  const match = ordinary[0] ?? pages[0];
  if (!match) throw notFound(endpoint, pages, "a page");
  return match;
}

function notFound(endpoint: string, pages: CdpTarget[], what: string): ScreenStudioError {
  return new ScreenStudioError("source_not_found", `No ${what} at ${endpoint}`, {
    hint: pages.length
      ? `Open tabs: ${pages
          .map((p) => p.url || p.id)
          .slice(0, 6)
          .join(", ")}`
      : "The browser has no open pages.",
  });
}

// ---------------------------------------------------------------------------
// Screencast capture
// ---------------------------------------------------------------------------

export interface BrowserSourceSpec {
  kind: "browser";
  /** DevTools endpoint; see `parseCdpEndpoint`. */
  endpoint: string;
  urlContains?: string;
  targetId?: string;
  /** Upper bound on captured pixels; Chrome scales frames down to fit. */
  maxSize?: Size;
  quality?: number;
  /**
   * Record the tab's own input as actions (exact targets, any driving tool).
   * Default: true. Turn off when the controller reports actions itself.
   */
  observe?: boolean;
}

const FIRST_FRAME_TIMEOUT_MS = 10_000;

export async function browserBackend(
  spec: BrowserSourceSpec,
  label?: string
): Promise<CaptureBackend> {
  const target = await resolvePageTarget(spec.endpoint, spec);
  return {
    id: `browser:${target.webSocketDebuggerUrl}`,
    kind: "browser",
    backend: "cdp-screencast",
    label: label ?? (target.title || target.url || "Browser tab"),
    details: { endpoint: spec.endpoint, targetId: target.id, url: target.url, title: target.title },
    start: (context) => startScreencast(target, spec, context),
  };
}

async function startScreencast(
  target: CdpTarget,
  spec: BrowserSourceSpec,
  context: CaptureContext
): Promise<ActiveCapture> {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const partPath = join(context.mediaDir, "screen.part.mp4");
  const finalPath = join(context.mediaDir, "screen.mp4");
  let stopped = false;
  let viewport: Size | null = null;

  const pump = new FramePump({
    outputPath: partPath,
    fps: context.fps,
    log: context.log,
    onUnexpectedExit: (error) => context.onFailure(error),
  });

  client.on("Page.screencastFrame", (params) => {
    const sessionId = params.sessionId as number;
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (stopped) return;
    const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
    if (metadata.deviceWidth && metadata.deviceHeight) {
      const next = {
        width: Math.round(metadata.deviceWidth),
        height: Math.round(metadata.deviceHeight),
      };
      if (viewport && (viewport.width !== next.width || viewport.height !== next.height)) {
        context.onGeometry(next);
      }
      viewport = next;
    }
    pump.push(Buffer.from(String(params.data), "base64"));
  });
  client.onClose((reason) => {
    if (!stopped) context.onSourceLost(`browser tab disconnected: ${reason}`);
  });
  client.on("Inspector.detached", (params) => {
    if (!stopped)
      context.onSourceLost(`browser tab detached: ${String(params.reason ?? "unknown")}`);
  });

  const maxSize = spec.maxSize ?? { width: 2560, height: 1600 };
  let stopObserving: (() => Promise<void>) | null = null;
  try {
    await client.send("Page.enable");
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: spec.quality ?? 85,
      maxWidth: maxSize.width,
      maxHeight: maxSize.height,
      everyNthFrame: 1,
    });
    if (spec.observe !== false && context.onEvent) {
      stopObserving = await observePage(client, context.onEvent);
    }
    await withTimeout(
      pump.ready,
      FIRST_FRAME_TIMEOUT_MS,
      () =>
        new ScreenStudioError("source_unavailable", "The tab sent no frames", {
          hint:
            "Make sure the tab is visible: hidden tabs and hidden <webview>s (visibility:hidden, " +
            "display:none, offscreen) are not painted.",
        })
    );
  } catch (err) {
    stopped = true;
    pump.kill();
    client.close();
    throw err;
  }

  return {
    mediaStartEpochMs: pump.startedAtEpochMs!,
    // A CDP frame reaches us within a few ms of compositing; the first one can
    // be older (it is the last frame painted before the screencast began).
    uncertaintyMs: 20,
    clockMethod: "recorder-constant-rate: frame k is shown at mediaStart + k/fps",
    geometry: viewport && pump.size ? { viewport, media: pump.size } : undefined,
    pointerInPixels: "none",
    childPids: pump.pid ? [pump.pid] : [],
    stats: () => ({ frames: pump.framesWritten }),
    async stop() {
      stopped = true;
      const stopAt = Date.now();
      await stopObserving?.();
      await client.send("Page.stopScreencast", {}, 2_000).catch(() => {});
      client.close();
      await pump.stop(stopAt);
      return finalizeFragmented(partPath, finalPath);
    },
  };
}

/** Rewrite the crash-safe fragmented file as a faststart MP4 editors prefer. */
export async function finalizeFragmented(
  partPath: string,
  finalPath: string
): Promise<{ path: string; warnings: string[] }> {
  try {
    await remux(partPath, finalPath);
    await unlink(partPath).catch(() => {});
    return { path: finalPath, warnings: [] };
  } catch (err) {
    return {
      path: partPath,
      warnings: [
        `Kept the fragmented recording; faststart remux failed: ${(err as Error).message}`,
      ],
    };
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
