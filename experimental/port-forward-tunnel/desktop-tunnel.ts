/**
 * Desktop-side tunnel listener.
 *
 * This is the piece that runs ON THE DESKTOP (in Conductor's case, inside the
 * Tauri/Rust app's PortForwardManager). It owns the local TCP listener and
 * the outgoing WebSockets to the sandbox.
 *
 * In real Conductor:
 *   - PortForwardManager (Rust) binds `127.0.0.1:localPort`.
 *   - On each TCP accept, it emits `port-forward-token-request` to the
 *     frontend/sidecar and waits for `resolve_port_forward_token`.
 *   - With the resolved token, it opens a raw WebSocket to the sandbox URL.
 *   - Pumps bytes between TCP and WS, terminates both on either close.
 *
 * This module exposes a single function `startTunnelListener(opts)` that
 * does the same thing in Bun/TypeScript. The `getToken` option is a callback
 * so callers can implement whatever auth dance fits their system — static
 * secret, JWT, RPC roundtrip, prompt the user, etc.
 *
 * Usage:
 *   const handle = startTunnelListener({
 *     localPort: 8080,
 *     remotePort: 3000,
 *     serverUrl: "ws://127.0.0.1:9999",
 *     getToken: async () => "secret-token",
 *   });
 *   // ... later:
 *   handle.close();
 */

import type { Socket } from "bun";

export interface TunnelListenerOptions {
  /** Local TCP port to bind on 127.0.0.1. */
  localPort: number;
  /** Tunnel server WS URL (e.g. `ws://127.0.0.1:9999` or `wss://sandbox.example.com`). */
  serverUrl: string;
  /** Port inside the remote sandbox to forward to. */
  remotePort: number;
  /**
   * Called once per accepted TCP connection. Return a token string that the
   * tunnel server will validate. This is where Conductor would do its
   * `port-forward-token-request` IPC roundtrip.
   *
   * Implementation tip: cache tokens with a TTL (~30s) instead of fetching
   * one per connection.
   */
  getToken: (args: {
    connectionId: string;
    remotePort: number;
  }) => string | Promise<string>;
  /** Bind hostname. Stay on 127.0.0.1 unless you specifically know why not. */
  hostname?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Upgrade path on the server. Defaults to "/port-forward". */
  upgradePath?: string;
}

export interface TunnelListenerHandle {
  /** Close the local TCP listener (does NOT close in-flight connections). */
  close(): void;
}

interface SocketState {
  ws: WebSocket | null;
  pendingBytes: Uint8Array[];
  wsReady: boolean;
  connectionId: string;
}

export function startTunnelListener(
  opts: TunnelListenerOptions,
): TunnelListenerHandle {
  const hostname = opts.hostname ?? "127.0.0.1";
  const upgradePath = opts.upgradePath ?? "/port-forward";
  const log = opts.log ?? ((m: string) => console.log(`[desktop-tunnel] ${m}`));

  const tcpServer = Bun.listen<SocketState>({
    hostname,
    port: opts.localPort,
    socket: {
      open(tcpSocket) {
        const connectionId = crypto.randomUUID().slice(0, 8);
        const state: SocketState = {
          ws: null,
          pendingBytes: [],
          wsReady: false,
          connectionId,
        };
        tcpSocket.data = state;

        // Resolve token, then open WS. Async — TCP bytes during this window
        // get buffered (state.pendingBytes).
        Promise.resolve(opts.getToken({ connectionId, remotePort: opts.remotePort }))
          .then((token) => openWebSocket(tcpSocket, state, token, opts, upgradePath, log))
          .catch((err) => {
            log(`[${connectionId}] token resolution failed: ${(err as Error).message}`);
            tcpSocket.end();
          });
      },

      data(tcpSocket, chunk) {
        const state = tcpSocket.data;
        if (state.wsReady && state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(chunk);
        } else {
          state.pendingBytes.push(new Uint8Array(chunk));
        }
      },

      close(tcpSocket) {
        const state = tcpSocket.data;
        log(`[${state.connectionId}] TCP closed → closing WS`);
        if (state.ws) {
          try {
            state.ws.close(1000, "tcp_closed");
          } catch {}
        }
      },

      error(tcpSocket, err) {
        const state = tcpSocket.data;
        log(`[${state.connectionId}] TCP error: ${err.message}`);
        if (state.ws) {
          try {
            state.ws.close(1011, "tcp_error");
          } catch {}
        }
      },
    },
  });

  log(
    `listening on ${hostname}:${opts.localPort} → ${opts.serverUrl}${upgradePath} → remote :${opts.remotePort}`,
  );

  return {
    close() {
      tcpServer.stop(true);
      log(`stopped listener on ${hostname}:${opts.localPort}`);
    },
  };
}

function openWebSocket(
  tcpSocket: Socket<SocketState>,
  state: SocketState,
  token: string,
  opts: TunnelListenerOptions,
  upgradePath: string,
  log: (m: string) => void,
) {
  const url =
    `${opts.serverUrl}${upgradePath}` +
    `?port=${opts.remotePort}` +
    `&token=${encodeURIComponent(token)}`;
  log(`[${state.connectionId}] TCP accepted → opening WS to ${url}`);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    state.wsReady = true;
    const pending = state.pendingBytes;
    state.pendingBytes = [];
    for (const chunk of pending) ws.send(chunk);
    log(
      `[${state.connectionId}] WS open (${pending.length} buffered chunk(s) flushed)`,
    );
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") return; // text frames reserved for control
    const buf =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(ev.data as ArrayBufferLike);
    tcpSocket.write(buf);
  };

  ws.onerror = (ev) => {
    log(`[${state.connectionId}] WS error: ${(ev as ErrorEvent).message ?? "(no message)"}`);
    tcpSocket.end();
  };

  ws.onclose = (ev) => {
    log(`[${state.connectionId}] WS closed (code=${ev.code} reason=${ev.reason || "—"})`);
    try {
      tcpSocket.end();
    } catch {}
  };
}
