import { WebSocket, type RawData } from "ws";

export type JsonObject = Record<string, unknown>;

export interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  cdpBaseUrl?: string;
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

export function getNativeCdpBaseUrl(): string {
  const configured = process.env.BROWSER_CDP_URL;
  const baseUrl = configured || `http://127.0.0.1:${getCdpPort()}`;
  return baseUrl.replace(/\/+$/, "");
}

export async function listTargets(cdpBaseUrl = getNativeCdpBaseUrl()): Promise<CdpTarget[]> {
  return (await fetchJson<CdpTarget[]>(`${cdpBaseUrl}/json`)).map((target) => ({
    ...target,
    cdpBaseUrl,
  }));
}

export async function getBrowserWsUrl(cdpBaseUrl = getNativeCdpBaseUrl()): Promise<string | null> {
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `${cdpBaseUrl}/json/version`
    );
    return version.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

export async function findTargetById(
  targetId: string,
  cdpBaseUrl = getNativeCdpBaseUrl()
): Promise<CdpTarget | null> {
  const targets = await listTargets(cdpBaseUrl);
  return targets.find((target) => target.id === targetId) ?? null;
}

export async function findTargetByUrl(
  url: string | undefined,
  cdpBaseUrl = getNativeCdpBaseUrl()
): Promise<CdpTarget | null> {
  if (!url || url === "about:blank") return null;
  const targets = await listTargets(cdpBaseUrl);
  return (
    targets.find(
      (target) =>
        isUsablePageTarget(target) && !claimedTargetIds.has(target.id) && target.url === url
    ) ?? null
  );
}

export async function createTarget(
  url: string | undefined,
  cdpBaseUrl = getNativeCdpBaseUrl()
): Promise<CdpTarget> {
  const targetUrl = url || "about:blank";

  const browserWsUrl = await getBrowserWsUrl(cdpBaseUrl);
  if (browserWsUrl) {
    let browserClient: CdpClient | null = null;
    try {
      browserClient = await CdpClient.connect(browserWsUrl);
      const result = (await browserClient.send("Target.createTarget", {
        url: targetUrl,
      })) as { targetId?: string };
      if (result.targetId) {
        const created = await findTargetById(result.targetId, cdpBaseUrl);
        if (created?.webSocketDebuggerUrl) return created;
      }
    } catch {
      // Fall back to the HTTP endpoint below.
    } finally {
      browserClient?.close();
    }
  }

  const created = await fetchJson<CdpTarget>(
    `${cdpBaseUrl}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" }
  );
  if (!created.webSocketDebuggerUrl) {
    throw new Error("Created CDP target did not expose a debugger URL");
  }
  return { ...created, cdpBaseUrl };
}

export async function closeTarget(
  targetId: string,
  cdpBaseUrl = getNativeCdpBaseUrl()
): Promise<void> {
  const browserWsUrl = await getBrowserWsUrl(cdpBaseUrl);
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

  await fetch(`${cdpBaseUrl}/json/close/${encodeURIComponent(targetId)}`).catch(() => {});
}

export function claimTarget(targetId: string): void {
  claimedTargetIds.add(targetId);
}

export function unclaimTarget(targetId: string): void {
  claimedTargetIds.delete(targetId);
}

export function replaceClaimedTarget(oldTargetId: string, newTargetId: string): void {
  claimedTargetIds.delete(oldTargetId);
  claimedTargetIds.add(newTargetId);
}

export function isUsablePageTarget(target: CdpTarget): boolean {
  return target.type === "page" && !!target.webSocketDebuggerUrl && !isAppRendererTarget(target);
}

export class CdpClient {
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

function getCdpPort(): string {
  const port = process.env.CDP_PORT ?? "19222";
  if (!port) {
    throw new Error("CDP_PORT is not set. Start the Electron desktop app to enable browser relay.");
  }
  return port;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`CDP request failed ${res.status}: ${url}`);
  return (await res.json()) as T;
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
