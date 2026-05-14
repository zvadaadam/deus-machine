/**
 * Standalone runner for the desktop-side tunnel.
 *
 * In production this would be embedded into your desktop app's process —
 * for Deus, that's Electron's main process; for Conductor, the Tauri/Rust
 * core. Here it's a standalone Bun process for ease of running the demo.
 *
 * Run:
 *   LOCAL_PORT=8080 REMOTE_PORT=3000 TUNNEL_URL=ws://127.0.0.1:9999 TUNNEL_TOKEN=secret-token bun run-desktop.ts
 */

import { startTunnelListener } from "./desktop-tunnel.ts";

const handle = startTunnelListener({
  localPort: Number(process.env.LOCAL_PORT ?? 8080),
  serverUrl: process.env.TUNNEL_URL ?? "ws://127.0.0.1:9999",
  remotePort: Number(process.env.REMOTE_PORT ?? 3000),

  // Simple static-token implementation for the demo.
  // In production, this would call out to your auth service to mint a fresh,
  // port-scoped, short-lived token. Conductor does this via Tauri IPC:
  //   1. Rust emits `port-forward-token-request` event
  //   2. Frontend (or sidecar) replies with `resolve_port_forward_token`
  //   3. Rust uses the token in the WS URL
  getToken: () => process.env.TUNNEL_TOKEN ?? "secret-token",
});

// Clean shutdown
process.on("SIGINT", () => {
  handle.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  handle.close();
  process.exit(0);
});
