// agent-server/agents/codex-server/codex-server-client.ts
// Lightweight JSONL JSON-RPC client for `codex app-server --listen stdio://`.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import type {
  CodexAppServerMethod,
  CodexAppServerNotification,
  CodexAppServerRequestMap,
} from "./codex-server-types";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

type RpcId = number;
type NotificationHandler = (notification: CodexAppServerNotification) => void;

type RpcMessage =
  | { id: RpcId; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
  | { id?: RpcId; method: string; params?: unknown };

export interface CodexAppServerClientOptions {
  codexPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export class CodexAppServerClient {
  private readonly codexPath: string;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private exited = false;

  constructor(options: CodexAppServerClientOptions) {
    this.codexPath = options.codexPath || "codex";
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async initialize(): Promise<void> {
    this.start();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.startupTimeoutMs);
    try {
      await this.request(
        "initialize",
        {
          clientInfo: { name: "deus-machine", title: null, version: "0.0.0" },
          capabilities: null,
        },
        { signal: controller.signal }
      );
    } catch (error) {
      this.close();
      if (controller.signal.aborted) {
        throw new Error(`Codex app-server did not initialize within ${this.startupTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  request<M extends CodexAppServerMethod>(
    method: M,
    params: CodexAppServerRequestMap[M]["params"],
    options?: { signal?: AbortSignal }
  ): Promise<CodexAppServerRequestMap[M]["result"]> {
    if (!this.proc || this.exited) {
      throw new Error("Codex app-server is not running");
    }

    const id = this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal: options?.signal,
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new Error(`Codex app-server request aborted: ${method}`));
          return;
        }
        pending.abortHandler = () => {
          this.pending.delete(id);
          reject(new Error(`Codex app-server request aborted: ${method}`));
        };
        options.signal.addEventListener("abort", pending.abortHandler, { once: true });
      }

      this.pending.set(id, pending);
      this.write(payload);
    });
  }

  close(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.exited = true;

    for (const [id, pending] of this.pending) {
      this.detachAbortHandler(pending);
      pending.reject(new Error(`Codex app-server closed before ${pending.method} completed`));
      this.pending.delete(id);
    }

    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  }

  private start(): void {
    if (this.proc && !this.exited) return;

    this.exited = false;
    const proc = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`[codex app-server stderr] ${text}`);
    });
    proc.on("error", (error) => this.handleExit(error));
    proc.on("exit", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited with code ${code} signal ${signal}`));
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        this.handleMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        console.warn("[codex app-server] Failed to parse JSON-RPC line:", error);
      }
    }
  }

  private handleMessage(message: RpcMessage): void {
    if ("id" in message && !("method" in message)) {
      this.handleResponse(message);
      return;
    }

    if ("method" in message && typeof message.method === "string") {
      if ("id" in message && typeof message.id === "number") {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported Codex app-server request: ${message.method}`,
          },
        });
        return;
      }

      const notification = {
        method: message.method,
        params: message.params,
      } as CodexAppServerNotification;
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private handleResponse(response: Extract<RpcMessage, { id: RpcId }>): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    this.detachAbortHandler(pending);

    if (response.error) {
      pending.reject(
        new Error(
          response.error.message ??
            `Codex app-server request failed: ${pending.method} (${response.error.code ?? "error"})`
        )
      );
      return;
    }

    pending.resolve(response.result);
  }

  private handleExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;

    for (const [id, pending] of this.pending) {
      this.detachAbortHandler(pending);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private detachAbortHandler(pending: PendingRequest): void {
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  }

  private write(payload: unknown): void {
    if (!this.proc || this.exited) {
      throw new Error("Codex app-server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
