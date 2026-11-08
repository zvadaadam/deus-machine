// Deus Cloud Relay — Cloudflare Worker entry point.
// Verifies each socket's Deus Cloud ticket, then routes the upgrade to the
// RelayDO for that machine (one Durable Object per registered computer).

import { Hono } from "hono";
import { ADMISSION_HEADER } from "./relay-do";
import { MACHINE_ID, TicketError, ticketFromProtocols, verifyTicket } from "./tickets";
import type { Bindings } from "./types";

export { RelayDO } from "./relay-do";

const app = new Hono<{ Bindings: Bindings }>();

const ROLE_BY_ENDPOINT = { tunnel: "host", connect: "client", pair: "client" } as const;

app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "deus-relay",
  })
);

// tunnel: the computer hosting the machine. connect/pair: the account's other devices.
app.get("/api/servers/:serverId/:endpoint{tunnel|connect|pair}", async (c) => {
  const machineId = c.req.param("serverId");
  const endpoint = c.req.param("endpoint") as keyof typeof ROLE_BY_ENDPOINT;
  if (!MACHINE_ID.test(machineId)) return c.json({ error: "Invalid server ID" }, 400);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  }

  const ticket = ticketFromProtocols(c.req.header("sec-websocket-protocol"));
  if (!ticket) return c.json({ error: "Account ticket required" }, 401);
  let admission;
  try {
    admission = await verifyTicket(c.env.RELAY_TICKET_JWKS, ticket);
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return c.json({ error: error.message }, 401);
  }
  if (admission.machineId !== machineId || admission.role !== ROLE_BY_ENDPOINT[endpoint]) {
    return c.json({ error: "Ticket is for another connection" }, 403);
  }

  // Only this Worker reaches the DO, and it overwrites any inbound copy of the header.
  const headers = new Headers(c.req.raw.headers);
  headers.set(ADMISSION_HEADER, JSON.stringify(admission));
  const url = new URL(c.req.url);
  url.pathname = `/${endpoint}`;
  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(machineId));
  return stub.fetch(new Request(url, { method: "GET", headers }));
});

app.get("/", (c) =>
  c.json({
    name: "deus-relay",
    version: "0.2.0",
    docs: "https://deusmachine.ai",
  })
);

export default app;
