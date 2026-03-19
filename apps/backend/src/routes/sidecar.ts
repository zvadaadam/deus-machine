import { Hono } from "hono";
import {
  sendMessage,
  receiveMessage,
  sendResponseToSidecar,
  isSidecarConnected,
  getSidecarSocketPath,
} from "../services/sidecar.service";

const sidecarRoutes = new Hono();

/** Send a JSON-RPC message to the sidecar and wait for response. */
sidecarRoutes.post("/sidecar/send", async (c) => {
  let body: { message?: string };
  try {
    body = await c.req.json<{ message: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { message } = body;
  if (!message) return c.json({ error: "message required" }, 400);

  try {
    sendMessage(message);
    const response = await receiveMessage();
    return c.json({ response });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Send failed" }, 500);
  }
});

/** Send a response back to the sidecar (for bidirectional RPC). */
sidecarRoutes.post("/sidecar/respond", async (c) => {
  let body: { response?: string };
  try {
    body = await c.req.json<{ response: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { response } = body;
  if (!response) return c.json({ error: "response required" }, 400);

  sendResponseToSidecar(response);
  return c.json({ success: true });
});

/** Check sidecar connection status. */
sidecarRoutes.get("/sidecar/status", (c) => {
  return c.json({
    connected: isSidecarConnected(),
    socketPath: getSidecarSocketPath(),
  });
});

export default sidecarRoutes;
