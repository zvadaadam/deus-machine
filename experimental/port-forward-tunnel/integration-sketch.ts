/**
 * Integration sketch — shows how the SANDBOX-SIDE tunnel handler would be
 * mounted alongside other endpoints in a real sandbox runtime.
 *
 * This isn't run by the demo. It's a reference for what the real integration
 * looks like in something like Deus's `apps/agent-server/` or Conductor's
 * `conductor-runtime child` mode.
 *
 * The key idea: the tunnel handler is a MOUNTABLE pair of (fetch handler,
 * websocket handler). It doesn't own the HTTP server. Your sandbox runtime
 * owns one server and routes among many capabilities — agent RPC, session
 * events, port forwarding, etc.
 */

import { createTunnelHandlers } from "./sandbox-tunnel.ts";

// ── Imagine a real sandbox runtime ───────────────────────────────────────

// Real sandboxes need to validate tokens against actual credentials.
// Conductor probably has something like:
async function validateAgainstRoundhouse(args: {
  port: number;
  token: string;
  request: Request;
}): Promise<boolean> {
  // 1. Verify the token is a JWT signed by Roundhouse, OR
  // 2. POST to Roundhouse's `/tokens/verify` with { workspaceId, port, token }, OR
  // 3. Decrypt a short-lived token with a workspace-scoped key.
  //
  // The token should be bound to (workspace, port) and have a short TTL.
  // Returning `true` here for the sketch.
  console.log(`[validate] port=${args.port} token=${args.token.slice(0, 8)}…`);
  return true;
}

// Per-session WebSocket data for the agent protocol — different from tunnel data.
interface AgentSessionData {
  kind: "agent-session";
  sessionId: string;
}

// Multiplex multiple data shapes on one server using a discriminated union.
type ServerWsData = AgentSessionData | import("./sandbox-tunnel.ts").TunnelData;

// ── The sandbox runtime's single Bun.serve ───────────────────────────────

const tunnel = createTunnelHandlers({
  validateToken: validateAgainstRoundhouse,
  // upgradePath defaults to "/port-forward"
});

Bun.serve<ServerWsData, string>({
  port: 8000,
  hostname: "0.0.0.0", // sandboxes bind to all interfaces so Roundhouse can reach them

  async fetch(req, server) {
    const url = new URL(req.url);

    // 1. Health check
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    // 2. Port forward upgrade — delegated to the tunnel module.
    //    If handleFetch returns:
    //      undefined → it upgraded successfully, Bun takes over
    //      Response  → it rejected (401/400/etc.)
    //      null      → it wasn't for us, keep routing
    const tunnelResponse = await tunnel.handleFetch(req, server);
    if (tunnelResponse !== null) return tunnelResponse;

    // 3. Agent session upgrade — this is where you'd handle /sessions/:id/ws etc.
    if (url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/ws")) {
      const sessionId = url.pathname.split("/")[2];
      const data: AgentSessionData = { kind: "agent-session", sessionId };
      const upgraded = server.upgrade(req, { data });
      if (!upgraded) return new Response("Upgrade failed", { status: 500 });
      return undefined;
    }

    // 4. JSON RPC for agent operations
    if (url.pathname === "/rpc" && req.method === "POST") {
      // ... handle query/cancel/warm_agent/etc.
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },

  // The websocket handler is a UNION of all per-route WS handlers.
  // Below dispatches via discriminator. The tunnel data has `targetPort`;
  // agent session data has `kind: "agent-session"`.
  websocket: {
    open(ws) {
      if ("kind" in ws.data && ws.data.kind === "agent-session") {
        console.log(`[agent-session] opened ${ws.data.sessionId}`);
        return;
      }
      // Otherwise it's a tunnel WS — delegate.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tunnel.websocket.open as any)(ws);
    },
    message(ws, msg) {
      if ("kind" in ws.data && ws.data.kind === "agent-session") {
        // ... agent session message handling
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tunnel.websocket.message as any)(ws, msg);
    },
    close(ws, code, reason) {
      if ("kind" in ws.data && ws.data.kind === "agent-session") {
        // ... agent session close
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tunnel.websocket.close as any)?.(ws, code, reason);
    },
  },
});

console.log("[integration-sketch] sandbox runtime listening on :8000");
console.log("[integration-sketch] /port-forward, /sessions/:id/ws, /rpc all on one server");

// ── What this shows ──────────────────────────────────────────────────────
//
// The tunnel module:
//   - Has its own typed connection state (TunnelData) that lives in ws.data
//   - Doesn't own a port — your runtime does
//   - Doesn't own auth — you supply validateToken
//   - Doesn't own logging — you supply log
//
// So in Deus's apps/agent-server, you'd:
//   1. import { createTunnelHandlers } from "./port-forward/sandbox-tunnel"
//   2. Wire validateToken to your existing per-workspace token verifier
//   3. In your fetch handler, check tunnel.handleFetch BEFORE your own routes
//   4. In your websocket handlers, dispatch based on ws.data shape
//
// And on the desktop (Electron main process):
//   1. import { startTunnelListener } from "./port-forward/desktop-tunnel"
//   2. Listen for "user enabled a port forward" IPC events from the renderer
//   3. For each, call startTunnelListener(...) and stash the handle
//   4. For each "stop", call handle.close()
//
// The pure modules are reusable; the standalone runners (run-sandbox.ts,
// run-desktop.ts) are just for the demo.
