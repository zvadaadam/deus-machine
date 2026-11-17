import { Hono } from "hono";
import { getDatabase } from "../lib/database";
import { getServerPort } from "../server";

const app = new Hono();

app.get("/health", (c) => {
  const db = getDatabase();
  // Note: Agent-server status removed - agent-server status is reported via WebSocket
  return c.json({
    app: "deus-backend",
    status: "ok",
    port: getServerPort(),
    timestamp: new Date().toISOString(),
    database: db ? "connected" : "disconnected",
  });
});

export default app;
