// shared/agent-side-channel.ts
// Deus-specific control frames multiplexed onto the same NDJSON pipe as the
// standard @zvada/agent-server wire. The upstream wire is strictly
// client→server requests plus one server→client `event` notification — every
// Deus extra (tool round-trips to the backend, AAP MCP hot-swap, provider
// auth, session titles) rides this side channel instead.
//
// Discrimination is unambiguous by construction:
//   - side-channel methods are namespaced `deus/…`
//   - side-channel request ids are strings namespaced `deus:<n>` (the upstream
//     client and server use integer ids)
// Each endpoint claims its own frames via `handleLine` BEFORE the upstream
// wire sees the line; everything unclaimed passes through untouched.

// ============================================================================
// Method names
// ============================================================================

export const SIDE_CHANNEL_METHOD_PREFIX = "deus/";
export const SIDE_CHANNEL_ID_PREFIX = "deus:";

export const SIDE_CHANNEL = {
  /** Notification, backend → agent-server: marks the sending transport as THE
   *  Deus host — the connection that answers tool round-trips. */
  hello: "deus/hello",
  /** Notification, agent-server → backend: claude SDK session summary. */
  title: "deus/title",

  // Requests, backend → agent-server
  providerAuth: "deus/provider-auth",
  aapRegisterMcp: "deus/aap/register-mcp",
  aapUnregisterMcp: "deus/aap/unregister-mcp",

  // Requests, agent-server → backend (deus MCP tool round-trips)
  exitPlanMode: "deus/exitPlanMode",
  askUserQuestion: "deus/askUserQuestion",
  getDiff: "deus/getDiff",
  diffComment: "deus/diffComment",
  getTerminalOutput: "deus/getTerminalOutput",
  getSimulatorContext: "deus/getSimulatorContext",
  aapListApps: "deus/aap/list-apps",
  aapLaunchApp: "deus/aap/launch-app",
  aapStopApp: "deus/aap/stop-app",
  aapReadAppSkill: "deus/aap/read-app-skill",
} as const;

/** Payload of the `deus/title` notification. */
export interface SideChannelTitle {
  sessionId: string;
  agentHarness: string;
  title: string;
}

// ============================================================================
// Transport filtering
// ============================================================================

/** Structurally identical to @zvada/agent-server's WireTransport — defined
 *  here so this shared module needs no runtime import from the package. */
export interface LineTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): () => void;
  onClose(handler: (reason?: string) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

/** The subset of a node `ws` socket the wire glue needs. */
export interface WsSocketLike {
  send(data: string): void;
  close(): void;

  // adapter over node-ws's event emitter; listener args vary per event.
  on(event: "message" | "close", listener: (...args: any[]) => void): unknown;
}

/**
 * Bridge a connected node-ws socket into a LineTransport: NDJSON framing in
 * both directions, socket close → transport close. This is the ONE place the
 * deus wire glue lives — the backend link, the agent-server bridge, both CLIs,
 * and the integration tests all connect through it.
 */
export function wsLineTransport(ws: WsSocketLike): LineTransport {
  const lineHandlers = new Set<(line: string) => void>();
  const closeHandlers = new Set<(reason?: string) => void>();
  let closed = false;

  const end = (reason?: string) => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler(reason);
    lineHandlers.clear();
    closeHandlers.clear();
  };

  ws.on("message", (data: unknown) => {
    if (closed) return;
    const text =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? new TextDecoder().decode(data)
          : String(data);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      for (const handler of [...lineHandlers]) handler(line);
    }
  });
  ws.on("close", () => end("socket closed"));

  return {
    send(line) {
      if (!closed) ws.send(line);
    },
    onLine(handler) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (closed) return;
      ws.close();
      end("closed locally");
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Claim deus/* frames on a transport and return the upstream-only view.
 * Pending side-channel requests fail when the transport drops.
 */
export function claimSideChannel(
  transport: LineTransport,
  endpoint: SideChannelEndpoint
): LineTransport {
  transport.onClose(() => endpoint.failPending("connection closed"));
  return filterClaimedLines(transport, (line) => endpoint.handleLine(line));
}

/**
 * Wrap a transport so lines claimed by `claim` never reach the upstream wire.
 * `claim` runs on every inbound line; outbound `send` passes through untouched
 * (side-channel responses are written directly to the inner transport).
 */
export function filterClaimedLines(
  inner: LineTransport,
  claim: (line: string) => boolean
): LineTransport {
  return {
    send: (line) => inner.send(line),
    onLine: (handler) =>
      inner.onLine((line) => {
        if (!claim(line)) handler(line);
      }),
    onClose: (handler) => inner.onClose(handler),
    close: () => inner.close(),
    get closed() {
      return inner.closed;
    },
  };
}

// ============================================================================
// Endpoint
// ============================================================================

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One end of the side channel: register handlers for inbound `deus/…` frames
 * and issue outbound requests/notifications on the same pipe. Symmetric —
 * the backend and the agent-server each construct one per connection.
 */
export class SideChannelEndpoint {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();

  constructor(
    private readonly sendLine: (line: string) => void,
    private readonly label = "side-channel"
  ) {}

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request; `timeoutMs` undefined = wait indefinitely (user-facing). */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = `${SIDE_CHANNEL_ID_PREFIX}${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`[${this.label}] ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.sendLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Reject every in-flight request (transport dropped). */
  failPending(reason: string): void {
    for (const [, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Inspect one inbound line. Returns true when the frame belonged to the
   * side channel (and was fully handled here); false = pass through to the
   * upstream wire.
   */
  handleLine(line: string): boolean {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof msg !== "object" || msg === null) return false;

    const method = typeof msg.method === "string" ? msg.method : undefined;
    const id = msg.id;

    // Inbound side-channel request/notification
    if (method?.startsWith(SIDE_CHANNEL_METHOD_PREFIX)) {
      if (id === undefined || id === null) {
        this.notificationHandlers.get(method)?.(msg.params);
        return true;
      }
      void this.dispatchRequest(id as string | number, method, msg.params);
      return true;
    }

    // Response to one of OUR side-channel requests
    if (
      method === undefined &&
      typeof id === "string" &&
      id.startsWith(SIDE_CHANNEL_ID_PREFIX) &&
      ("result" in msg || "error" in msg)
    ) {
      const entry = this.pending.get(id);
      if (!entry) return true;
      this.pending.delete(id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if ("error" in msg && msg.error) {
        const err = msg.error as { message?: string };
        entry.reject(new Error(err.message ?? "side-channel request failed"));
      } else {
        entry.resolve(msg.result);
      }
      return true;
    }

    return false;
  }

  private async dispatchRequest(
    id: string | number,
    method: string,
    params: unknown
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown side-channel method: ${method}` },
        })
      );
      return;
    }
    try {
      const result = await handler(params);
      this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
    } catch (error) {
      this.sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
      );
    }
  }
}
