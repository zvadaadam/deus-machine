// device-use v2 server entrypoint.
// One Bun process serving:
//   /             — the React viewer (dev: proxy to Vite; prod: static bundle)
//   /health       — liveness
//   /api/state    — read persisted state
//   /api/tools    — list all tools + schemas
//   /api/tools/:name — POST to invoke a tool (REST)
//   /api/events   — GET snapshot of recent tool-events
//   /stream.mjpeg — MJPEG passthrough from simbridge
//   /mcp          — MCP HTTP transport for agents
//   /ws           — WebSocket: events out, optional tool invocations in
//   /sim-input    — WebSocket: binary passthrough to simbridge /ws
//                   for low-latency human touch input (matches simbridge's
//                   native protocol: 0x03 + JSON{type,x,y} for touch,
//                   0x04 + JSON{button} for hardware buttons)

import { Hono } from "hono";
import { createExecutor } from "../engine/index.js";
import { RefMap } from "../engine/snapshot/refs.js";
import { EventBus } from "./events.js";
import { invokeTool } from "./invoker.js";
import { createMcpHandler } from "./mcp.js";
import { StateStore, resolveStorageDir } from "./state.js";
import { StreamManager } from "./stream.js";
import { toolInputSchema, TOOLS, type Context } from "./tools.js";

const IS_DEV = process.env.NODE_ENV !== "production";

// --- Assemble shared context ---------------------------------------------

const events = new EventBus();
const state = new StateStore(resolveStorageDir());
const stream = new StreamManager();
const ctx: Context = {
  executor: createExecutor(),
  state,
  stream,
  events,
  refMap: new RefMap(),
};

await state.load();
// Auto-boot pinned sim on start (fire-and-forget; failures go to logs).
(async () => {
  const pinned = state.get().simulator?.udid;
  if (!pinned) return;
  try {
    const { bootSimulator } = await import("../engine/simctl.js");
    await bootSimulator(ctx.executor, pinned);
    await stream.start(pinned);
  } catch (err) {
    console.warn(`[boot] auto-boot of ${pinned} failed:`, (err as Error).message);
  }
})();

const mcpHandler = createMcpHandler(ctx);

// --- Routes --------------------------------------------------------------

const app = new Hono();
const STARTED_AT = Date.now();

app.get("/health", (c) =>
  c.json({ ok: true, uptime: Math.floor((Date.now() - STARTED_AT) / 1000) })
);

app.get("/api/state", (c) => c.json(state.get()));

app.get("/api/tools", (c) =>
  c.json({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toolInputSchema(t.schema),
    })),
  })
);

app.get("/api/events", (c) => c.json({ events: events.snapshot() }));

app.post("/api/tools/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const result = await invokeTool(ctx, name, body);
  return c.json(result, result.success ? 200 : 400);
});

app.all("/mcp", async (c) => mcpHandler(c.req.raw));

app.get("/stream.mjpeg", async () => stream.proxyStream());

app.get("/api/stream", (c) => c.json(stream.getInfo() ?? null));

// --- WebSocket via Bun.serve.upgrade ------------------------------------

const WS_SUBSCRIBERS = new Map<object, () => void>();
const WS_UPSTREAMS = new Map<object, { upstream: WebSocket; buffered: Array<ArrayBufferLike> }>();

app.get("/ws", (c) => {
  // Placeholder — actual upgrade happens in the Bun server wrapper below.
  return c.text("upgrade required", 426);
});

app.get("/sim-input", (c) => c.text("upgrade required", 426));

// --- Frontend (dev proxy or prod static) --------------------------------

if (IS_DEV) {
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const target = `http://localhost:5173${url.pathname}${url.search}`;
    try {
      const upstream = await fetch(target, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.raw.arrayBuffer(),
        redirect: "manual",
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch {
      return c.text(
        "Vite dev server not reachable on :5173. Run `bun run dev:frontend` in a second terminal.",
        502
      );
    }
  });
} else {
  const { serveStatic } = await import("hono/bun");
  app.use("*", serveStatic({ root: "./dist/frontend" }));
  app.get("*", serveStatic({ path: "./dist/frontend/index.html" }));
}

// --- Bun.serve with WebSocket upgrade -----------------------------------

const port = Number(process.env.PORT ?? 3100);
// Bind to 0.0.0.0 so localhost resolves to our listener regardless of
// whether the client uses IPv4 (127.0.0.1) or IPv6 (::1 → falls back to
// IPv4 via happy-eyeballs). 127.0.0.1-only binding can be shadowed by
// any IPv6 listener on the same port.
const host = process.env.HOST ?? "0.0.0.0";

console.log(`device-use server listening on http://${host}:${port} (${IS_DEV ? "dev" : "prod"})`);

export default {
  port,
  hostname: host,
  fetch(req: Request, server: any): Response | Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { kind: "events" } }))
        return new Response(null, { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/sim-input") {
      const info = stream.getInfo();
      if (!info) return new Response("no active simulator stream", { status: 503 });
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
      if (server.upgrade(req, { data: { kind: "sim-input", wsUrl } }))
        return new Response(null, { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws: {
      data: { kind: string; wsUrl?: string };
      send: (data: string | Uint8Array | ArrayBuffer) => void;
      close: () => void;
    }) {
      if (ws.data.kind === "events") {
        const unsubscribe = events.subscribe((event) => {
          try {
            ws.send(JSON.stringify(event));
          } catch {
            // client gone; ignore
          }
        });
        WS_SUBSCRIBERS.set(ws as unknown as object, unsubscribe);
        // Send recent history so the client can hydrate.
        for (const event of events.snapshot()) {
          ws.send(JSON.stringify(event));
        }
        return;
      }

      if (ws.data.kind === "sim-input" && ws.data.wsUrl) {
        // Open an upstream WS to simbridge and attach it to the client WS.
        // Messages are forwarded one-way (browser → simbridge) as raw binary.
        const upstream = new WebSocket(ws.data.wsUrl);
        upstream.binaryType = "arraybuffer";
        const buffered: Array<ArrayBufferLike> = [];
        upstream.addEventListener("open", () => {
          for (const buf of buffered) upstream.send(buf);
          buffered.length = 0;
        });
        upstream.addEventListener("error", (err) => {
          console.warn(`[sim-input] upstream error:`, String(err));
        });
        upstream.addEventListener("close", () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        });
        WS_UPSTREAMS.set(ws as unknown as object, { upstream, buffered });
        return;
      }
    },
    async message(
      ws: {
        data: { kind: string };
        send: (data: string | Uint8Array) => void;
      },
      message: string | Buffer | ArrayBuffer
    ) {
      if (ws.data.kind === "sim-input") {
        const bundle = WS_UPSTREAMS.get(ws as unknown as object);
        if (!bundle) return;
        // Normalize to ArrayBuffer for WebSocket.send.
        let ab: ArrayBufferLike;
        if (message instanceof ArrayBuffer) {
          ab = message;
        } else if (message instanceof Buffer) {
          ab = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
        } else {
          // string message on sim-input channel — wrap in UTF-8 bytes
          ab = new TextEncoder().encode(String(message)).buffer as ArrayBuffer;
        }
        if (bundle.upstream.readyState === WebSocket.OPEN) {
          bundle.upstream.send(ab);
        } else if (bundle.upstream.readyState === WebSocket.CONNECTING) {
          bundle.buffered.push(ab);
        }
        return;
      }
      // events channel — existing handler
      try {
        const data = JSON.parse(typeof message === "string" ? message : message.toString());
        if (data.type === "invoke" && typeof data.tool === "string") {
          const result = await invokeTool(ctx, data.tool, data.params ?? {});
          ws.send(
            JSON.stringify({ type: "invoke-result", correlationId: data.correlationId, ...result })
          );
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: (err as Error).message }));
      }
    },
    close(ws: { data: { kind: string } }) {
      if (ws.data.kind === "sim-input") {
        const bundle = WS_UPSTREAMS.get(ws as unknown as object);
        if (bundle) {
          bundle.upstream.close();
          WS_UPSTREAMS.delete(ws as unknown as object);
        }
        return;
      }
      const unsubscribe = WS_SUBSCRIBERS.get(ws as unknown as object);
      if (unsubscribe) {
        unsubscribe();
        WS_SUBSCRIBERS.delete(ws as unknown as object);
      }
    },
  },
};
