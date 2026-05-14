# Port-forward tunnel — Conductor's pattern, cleanly factored

A runnable prototype of the WebSocket-tunneled TCP forwarding that powers Conductor cloud workspaces. The goal isn't just to demo the data plane — it's to factor the code the way a real implementation should, so the sandbox-side handler can be embedded into a larger sandbox runtime (e.g. Deus's `apps/agent-server/`) without bringing along demo scaffolding.

## File layout — what runs where

```
experimental/port-forward-tunnel/
├── sandbox-tunnel.ts          ⟵ THE module that runs inside the cloud sandbox
├── desktop-tunnel.ts          ⟵ THE module that runs on the user's desktop
│
├── run-sandbox.ts             ⟵ thin standalone wrapper around sandbox-tunnel
├── run-desktop.ts             ⟵ thin standalone wrapper around desktop-tunnel
├── integration-sketch.ts      ⟵ reference: mounting sandbox-tunnel alongside other endpoints
│
├── target.ts                  ⟵ demo dev server (stands in for user's app inside sandbox)
├── demo.ts                    ⟵ spawns all three for end-to-end testing
│
├── README.md                  ⟵ this file
├── package.json
└── tsconfig.json
```

**The two-row split is intentional.** `sandbox-tunnel.ts` and `desktop-tunnel.ts` are pure modules — no top-level `Bun.serve`, no `process.env` reading, no logging coupling. They export functions you import into your existing runtime. The `run-*` files are 30-line standalone wrappers for the demo. The `integration-sketch.ts` shows what real integration looks like.

## Run it

```bash
cd experimental/port-forward-tunnel
bun demo.ts
# In another terminal:
curl http://localhost:8080/api/hello
curl http://localhost:8080/api/stream
curl -X POST -d "hello" http://localhost:8080/api/echo
```

Or browse to `http://localhost:8080`.

## Topology

```
   ┌──────────────────┐                                       ┌──────────────────┐
   │   your browser   │                                       │   target dev     │
   │   (or curl)      │                                       │   server         │
   └────────┬─────────┘                                       │   :3000          │
            │                                                 └────────▲─────────┘
            │ TCP                                                      │
            │                                                          │ TCP
   ┌────────▼──────────┐                                      ┌────────┴──────────┐
   │ DESKTOP tunnel    │                                      │ SANDBOX tunnel    │
   │ 127.0.0.1:8080    │ ─── binary WebSocket over HTTP ─────▶│ :9999             │
   │                   │                                      │                   │
   │ desktop-tunnel.ts │                                      │ sandbox-tunnel.ts │
   └───────────────────┘                                      └───────────────────┘

   (in real Conductor:                                        (in real Conductor:
    Rust, inside Tauri's                                       Bun/TS, inside the
    PortForwardManager)                                        conductor-runtime
                                                               child mode)
```

## API surface

### Sandbox side — `sandbox-tunnel.ts`

```ts
export function createTunnelHandlers(opts: TunnelHandlerOptions): TunnelHandlers;

interface TunnelHandlerOptions {
  validateToken?: (args: {
    port: number;
    token: string;
    request: Request;
  }) => boolean | Promise<boolean>;
  targetHostname?: string;       // defaults to 127.0.0.1
  upgradePath?: string;          // defaults to "/port-forward"
  log?: (msg: string) => void;
}

interface TunnelHandlers {
  handleFetch(req: Request, server: BunServerLike): Promise<Response | undefined | null>;
  websocket: WebSocketHandler<TunnelData>;
}
```

The return value is **mountable**. Your sandbox runtime calls `handleFetch` from its own `fetch` and dispatches to `websocket` from its own `websocket` handler. The module never calls `Bun.serve`. See `integration-sketch.ts` for a full example.

Three return values from `handleFetch`:
- `null` — not for us, keep routing
- `Response` — for us but rejected (400 bad port / 401 bad token)
- `undefined` — upgraded successfully, Bun is now in charge of the connection

### Desktop side — `desktop-tunnel.ts`

```ts
export function startTunnelListener(opts: TunnelListenerOptions): TunnelListenerHandle;

interface TunnelListenerOptions {
  localPort: number;
  serverUrl: string;
  remotePort: number;
  getToken: (args: { connectionId: string; remotePort: number }) =>
    string | Promise<string>;
  hostname?: string;             // defaults to 127.0.0.1
  log?: (msg: string) => void;
  upgradePath?: string;          // defaults to "/port-forward"
}

interface TunnelListenerHandle {
  close(): void;
}
```

`getToken` is a callback — the desktop calls it for each accepted TCP connection. This is where Conductor would do its `port-forward-token-request` → `resolve_port_forward_token` IPC dance. For the prototype, we just return a static string.

## How this maps to real Conductor

| Conductor element | Where it lives | What in this prototype |
|---|---|---|
| `PortForwardManager` (Rust) | Tauri desktop app | `desktop-tunnel.ts` |
| TCP listener on `127.0.0.1:localPort` | Rust core | `Bun.listen` in `desktop-tunnel.ts` |
| `port-forward-token-request` event | Rust → frontend IPC | `getToken` callback |
| `resolve_port_forward_token` command | Frontend → Rust IPC | (caller decides how to implement) |
| Raw WebSocket to sandbox | Rust `tungstenite`/`tokio-tungstenite` | Bun's native `WebSocket` |
| Sandbox WS endpoint (inferred) | Bun `conductor-runtime child` mode | `sandbox-tunnel.ts` |
| TCP-out to dev server | Bun `Bun.connect` | Bun `Bun.connect` |
| Binary frames for data | Conductor uses binary | Same |
| Text frames for control | Inferred reserved | Reserved, currently ignored |
| One WS per TCP connection | Yes (`connectionId` field on `RawWebSocketOpenArgs`) | Yes |

## How this would land in Deus

### Sandbox side (`apps/agent-server/`)

1. Copy `sandbox-tunnel.ts` into something like `apps/agent-server/src/port-forward.ts`.
2. Wire `validateToken` to your existing per-workspace token auth.
3. In your existing `Bun.serve` setup, call `tunnel.handleFetch(req, server)` before your own routes. Dispatch on `ws.data` shape in your `websocket` handler. See `integration-sketch.ts`.
4. That's it for the sandbox.

### Desktop side (Electron main process)

1. Convert `desktop-tunnel.ts` to use Node `net` instead of `Bun.listen`:
   - `Bun.listen({hostname, port, socket: {open, data, close, error}})` becomes `net.createServer((socket) => { socket.on('data', ...); ... }).listen(port, hostname)`.
   - `WebSocket` is a global in modern Node — keep it as-is.
   - Total work: ~30 lines changed.
2. Expose `startTunnelListener` from your Electron main process.
3. Wire IPC handlers from the renderer for `start_port_forward` / `stop_port_forward` / `list_port_forwards`.
4. In `getToken`, fetch a workspace-scoped token from your backend.

### Storage

Use Deus's existing SQLite for the `port_forwards` table (mirror Conductor's schema exactly — it's small):

```sql
CREATE TABLE port_forwards (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  remote_port  INTEGER NOT NULL,
  local_port   INTEGER NOT NULL,
  protocol     TEXT NOT NULL DEFAULT 'tcp',
  label        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_port_forwards_workspace_remote ON port_forwards(workspace_id, remote_port);
CREATE UNIQUE INDEX idx_port_forwards_local_port ON port_forwards(local_port);
```

On Deus desktop startup, hydrate active forwards: read all rows with `enabled = 1`, call `startTunnelListener` for each, stash the `handle`. On enable/disable/stop from UI, persist + call.

## What's still simplified

The prototype intentionally skips three things real systems need:

1. **Backpressure** — if the WS send buffer grows because the receiving side is slow, the local TCP socket should pause until it drains. Bun supports this (`socket.pause()` / `socket.resume()`), but adding it complicates the read loop. Without it, a slow consumer can pin memory.

2. **TLS** — production uses `wss://` over HTTPS. For the loopback demo, plaintext is fine. With a real Conductor setup, the URL is `wss://your-sandbox-host` and Bun's WebSocket handles TLS transparently (just change the scheme).

3. **Reconnect** — each TCP connection gets one WS. If the WS breaks, the TCP connection dies (matches Conductor). The user's app retries TCP, which gets a fresh WS. That's the right behavior — don't try to keep WS alive across TCP boundaries.

## Tested edge cases

The included demo run verified:

- ✅ Simple JSON GET round-trip
- ✅ POST with body (proves client → server data flow)
- ✅ Chunked streaming response (proves bytes flow back as they arrive, not buffered)
- ✅ 404 status code propagates
- ✅ Wrong token rejected with 401 before WS upgrade
- ✅ Missing port rejected with 400 before WS upgrade
- ✅ Clean shutdown on SIGINT
- ✅ One WS per TCP connection (visible in connection-id-tagged logs)
- ✅ Pre-WS-open buffering on both sides (logs show "1 buffered chunk(s) flushed")

## Where Conductor's design might surprise you

While writing this, two design choices stood out as non-obvious:

**One WebSocket per TCP connection, not multiplexed.** Conceptually cleaner — every TCP flow has its own auth, its own lifecycle, its own backpressure boundary. The alternative (multiplex many TCP flows over one WS with stream IDs) is more bandwidth-efficient but adds substantial protocol complexity (framing, fairness, head-of-line blocking). For dev workloads where you're not opening thousands of connections per second, one-WS-per-connection wins on simplicity.

**Token in URL query, not in a separate setup frame.** You'd think a "send hello, get ack" handshake pattern over the WS would be more flexible. But putting the token in the upgrade query means it's validated *before* the WS opens — bad tokens get an HTTP 401 immediately, no resources allocated. Faster, cleaner failure mode. The downside (token appears in access logs) is mitigated by short token TTLs.

Both choices reflect Conductor's preference for protocol simplicity over wire efficiency, and that's the right call for a tool used by humans interactively rather than machines at scale.
