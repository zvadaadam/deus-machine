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

import { Hono } from "hono";
import { createExecutor } from "../engine/index.js";
import { RefMap } from "../engine/snapshot/refs.js";
import { EventBus } from "./events.js";
import { invokeTool } from "./invoker.js";
import { createMcpHandler } from "./mcp.js";
import { StateStore, resolveStorageDir } from "./state.js";
import { StreamManager } from "./stream.js";
import { TOOLS, type Context } from "./tools.js";
import { zodToJsonSchema } from "zod-to-json-schema";

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
      inputSchema: zodToJsonSchema(t.schema as any, { target: "jsonSchema7" }),
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

const WS_SUBSCRIBERS = new Map<object, { unsubscribe: () => void; ws: unknown }>();

app.get("/ws", (c) => {
  // Placeholder — actual upgrade happens in the Bun server wrapper below.
  return c.text("upgrade required", 426);
});

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
const host = process.env.HOST ?? "127.0.0.1";

console.log(`device-use server listening on http://${host}:${port} (${IS_DEV ? "dev" : "prod"})`);

export default {
  port,
  hostname: host,
  fetch(req: Request, server: any): Response | Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return new Response(null, { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws: { data: unknown; send: (data: string) => void }) {
      const unsubscribe = events.subscribe((event) => {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          // client gone; ignore
        }
      });
      WS_SUBSCRIBERS.set(ws as unknown as object, { unsubscribe, ws });
      // Send recent history so the client can hydrate.
      for (const event of events.snapshot()) {
        ws.send(JSON.stringify(event));
      }
    },
    async message(ws: { send: (data: string) => void }, message: string | Buffer) {
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
    close(ws: { data: unknown }) {
      const sub = WS_SUBSCRIBERS.get(ws as unknown as object);
      if (sub) {
        sub.unsubscribe();
        WS_SUBSCRIBERS.delete(ws as unknown as object);
      }
    },
  },
};
