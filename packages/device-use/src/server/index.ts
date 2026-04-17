// Phase 1 scaffold: minimal Hono server on Bun.serve.
// Later phases add /mcp, /ws, /api/*, state.json, stream subprocess, etc.

import { Hono } from "hono";

const app = new Hono();
const STARTED_AT = Date.now();
const IS_DEV = process.env.NODE_ENV !== "production";

app.get("/health", (c) =>
  c.json({
    ok: true,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
  })
);

if (IS_DEV) {
  // In dev, proxy all non-API requests to Vite's dev server for HMR.
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
  // In prod, serve the Vite-built bundle from dist/frontend.
  const { serveStatic } = await import("hono/bun");
  app.use("*", serveStatic({ root: "./dist/frontend" }));
  app.get("*", serveStatic({ path: "./dist/frontend/index.html" }));
}

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

console.log(`device-use server listening on http://${host}:${port} (${IS_DEV ? "dev" : "prod"})`);

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
