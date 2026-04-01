// Deus Cloud Relay — Cloudflare Worker entry point.
// Routes WebSocket upgrades to the RelayDO (one Durable Object per server).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "./types";

export { RelayDO } from "./relay-do";

const app = new Hono<{ Bindings: Bindings }>();

// CORS for web portal and local dev
app.use(
  "*",
  cors({
    origin: ["https://app.deusmachine.ai", "http://localhost:3000", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Middleware: validate serverId and attach DO stub to context
const withRelay = createMiddleware<{
  Bindings: Bindings;
  Variables: { stub: DurableObjectStub };
}>(async (c, next) => {
  const serverId = c.req.param("serverId");
  if (!serverId || !/^[a-z0-9]{4,8}$/i.test(serverId)) {
    return c.json({ error: "Invalid server ID" }, { status: 400 });
  }
  const id = c.env.RELAY.idFromName(serverId);
  c.set("stub", c.env.RELAY.get(id));
  await next();
});

// Health check
app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "deus-relay",
  })
);

// Server tunnel — desktop server connects here to register with the relay
app.get("/api/servers/:serverId/tunnel", withRelay, async (c) => {
  const stub = c.get("stub");
  const tunnelUrl = new URL(c.req.url);
  tunnelUrl.pathname = "/tunnel";
  return stub.fetch(new Request(tunnelUrl, c.req.raw));
});

// Client connect — remote web/mobile clients connect here
app.get("/api/servers/:serverId/connect", withRelay, async (c) => {
  const stub = c.get("stub");
  const connectUrl = new URL(c.req.url);
  connectUrl.pathname = "/connect";
  return stub.fetch(new Request(connectUrl, c.req.raw));
});

// Pairing exchange — web portal exchanges a code for a device token
app.get("/api/servers/:serverId/pair", withRelay, async (c) => {
  const stub = c.get("stub");
  const pairUrl = new URL(c.req.url);
  pairUrl.pathname = "/pair";
  return stub.fetch(new Request(pairUrl, c.req.raw));
});

// Server status — check if a server is online
app.get("/api/servers/:serverId/status", withRelay, async (c) => {
  const stub = c.get("stub");
  return stub.fetch(new Request(new URL("/status", c.req.url)));
});

// Root
app.get("/", (c) =>
  c.json({
    name: "deus-relay",
    version: "0.1.0",
    docs: "https://app.deusmachine.ai",
  })
);

export default app;
