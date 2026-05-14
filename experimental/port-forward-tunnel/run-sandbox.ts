/**
 * Standalone runner for the sandbox-side tunnel.
 *
 * Mounts the tunnel handlers on a dedicated Bun.serve. In production this
 * would NOT be a separate process — see `integration-sketch.ts` for how to
 * mount alongside other endpoints in your sandbox runtime.
 *
 * Run:
 *   TUNNEL_PORT=9999 TUNNEL_TOKEN=secret-token bun run-sandbox.ts
 */

import { createTunnelHandlers } from "./sandbox-tunnel.ts";

const port = Number(process.env.TUNNEL_PORT ?? 9999);
const expectedToken = process.env.TUNNEL_TOKEN ?? "secret-token";

const handlers = createTunnelHandlers({
  validateToken: ({ token }) => token === expectedToken,
});

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const r = await handlers.handleFetch(req, server);
    if (r === undefined) return undefined; // upgraded — Bun handles it
    if (r) return r; // we returned an error response
    return new Response("Not found", { status: 404 });
  },
  websocket: handlers.websocket,
});

console.log(`[run-sandbox] listening on 127.0.0.1:${port}`);
console.log(`[run-sandbox] expected token: ${expectedToken}`);
