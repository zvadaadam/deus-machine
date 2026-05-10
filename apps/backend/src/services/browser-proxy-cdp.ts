import { WebSocket, type RawData } from "ws";

export type JsonObject = Record<string, unknown>;

export interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
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
