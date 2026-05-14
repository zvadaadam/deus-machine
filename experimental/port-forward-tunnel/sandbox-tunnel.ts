/**
 * Sandbox-side tunnel handler.
 *
 * This is the piece that runs INSIDE the cloud sandbox, alongside the agent
 * runtime, the session event notifier, the sleep monitor, etc. It does not
 * own its own HTTP server — it exposes mountable handlers that the sandbox's
 * existing HTTP/WS server can use.
 *
 * In real Conductor, the equivalent code lives inside `conductor-runtime
 * child` mode (Bun/TypeScript), one of many capabilities served from the same
 * binary.
 *
 * Usage (standalone):
 *   See run-sandbox.ts — uses Bun.serve directly.
 *
 * Usage (integrated):
 *   See integration-sketch.ts — mounts the handlers alongside other endpoints.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * Structural shape of Bun's Server with respect to what we use.
 * Avoids requiring callers to parameterize Bun.serve with our TunnelData type —
 * they can have any data shape on their server, and we still upgrade with ours.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServerLike = { upgrade: (req: Request, opts: { data: any }) => boolean };

export interface TunnelHandlerOptions {
  /**
   * Validates the token presented in the WS upgrade request.
   * Return `true` to allow the upgrade, `false` to reject with 401.
   * In production this calls into your auth service to verify the token is
   * (a) signed for THIS workspace, (b) scoped to THIS port, (c) not expired.
   * If omitted, every token is accepted (NEVER use this in production).
   */
  validateToken?: (args: {
    port: number;
    token: string;
    request: Request;
  }) => boolean | Promise<boolean>;

  /** Hostname to connect the target TCP to. Defaults to "127.0.0.1". */
  targetHostname?: string;

  /** URL path the WS upgrade lives at. Defaults to "/port-forward". */
  upgradePath?: string;

  /** Optional logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

/** Per-WebSocket state attached during upgrade. */
export interface TunnelData {
  targetPort: number;
  tcpSocket: import("bun").Socket | null;
  pendingBytes: Uint8Array[];
  ready: boolean;
  connectionId: string;
}

export interface TunnelHandlers {
  /**
   * Inspect a fetch Request. If it's a tunnel upgrade, upgrade and return
   * `undefined`. If not for us, return `null` so the caller can handle it.
   * If it's for us but invalid (bad port, bad token), return a Response with
   * the appropriate error status.
   */
  handleFetch(
    request: Request,
    server: BunServerLike,
  ): Promise<Response | undefined | null>;

  /** Mount this on Bun.serve({ websocket }). */
  websocket: WebSocketHandler<TunnelData>;
}

export function createTunnelHandlers(
  opts: TunnelHandlerOptions = {},
): TunnelHandlers {
  const targetHostname = opts.targetHostname ?? "127.0.0.1";
  const upgradePath = opts.upgradePath ?? "/port-forward";
  const log = opts.log ?? ((m: string) => console.log(`[sandbox-tunnel] ${m}`));
  const validateToken =
    opts.validateToken ??
    (() => {
      log("WARN: no validateToken supplied, accepting all tokens");
      return true;
    });

  return {
    async handleFetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== upgradePath) {
        return null; // not for us
      }

      const portParam = url.searchParams.get("port");
      const token = url.searchParams.get("token") ?? "";
      const port = portParam ? Number(portParam) : NaN;

      if (!port || Number.isNaN(port) || port < 1 || port > 65535) {
        return new Response("Bad or missing ?port", { status: 400 });
      }

      const allowed = await validateToken({ port, token, request });
      if (!allowed) {
        return new Response("Bad token", { status: 401 });
      }

      const connectionId = crypto.randomUUID().slice(0, 8);
      const tunnelData: TunnelData = {
        targetPort: port,
        tcpSocket: null,
        pendingBytes: [],
        ready: false,
        connectionId,
      };
      const upgraded = server.upgrade(request, { data: tunnelData });

      if (!upgraded) {
        return new Response("Upgrade failed", { status: 500 });
      }
      return undefined; // upgraded successfully — let Bun handle the rest
    },

    websocket: {
      async open(ws: ServerWebSocket<TunnelData>) {
        const { targetPort, connectionId } = ws.data;
        log(
          `[${connectionId}] WS open → connecting TCP to ${targetHostname}:${targetPort}`,
        );

        try {
          const tcpSocket = await Bun.connect({
            hostname: targetHostname,
            port: targetPort,
            socket: {
              data(_tcp, chunk) {
                if (ws.readyState === 1 /* OPEN */) {
                  ws.sendBinary(chunk);
                }
              },
              close() {
                log(`[${connectionId}] target TCP closed → closing WS`);
                ws.close(1000, "tcp_closed");
              },
              error(_tcp, err) {
                log(
                  `[${connectionId}] target TCP error: ${(err as Error).message}`,
                );
                ws.close(1011, "tcp_error");
              },
            },
          });

          ws.data.tcpSocket = tcpSocket;
          ws.data.ready = true;

          const pending = ws.data.pendingBytes;
          ws.data.pendingBytes = [];
          for (const chunk of pending) tcpSocket.write(chunk);
          log(
            `[${connectionId}] target TCP open (${pending.length} buffered chunk(s) flushed)`,
          );
        } catch (err) {
          log(
            `[${connectionId}] failed to connect to target :${targetPort} — ${(err as Error).message}`,
          );
          ws.close(1011, "target_unreachable");
        }
      },

      message(ws, message) {
        if (typeof message === "string") {
          log(`[${ws.data.connectionId}] ignoring text frame`);
          return;
        }
        if (ws.data.ready && ws.data.tcpSocket) {
          ws.data.tcpSocket.write(message);
        } else {
          ws.data.pendingBytes.push(new Uint8Array(message));
        }
      },

      close(ws, code, reason) {
        log(
          `[${ws.data.connectionId}] WS closed (${code} ${reason || "—"}) → closing target TCP`,
        );
        if (ws.data.tcpSocket) {
          try {
            ws.data.tcpSocket.end();
          } catch {}
        }
      },
    },
  };
}
