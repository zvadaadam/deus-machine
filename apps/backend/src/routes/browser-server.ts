import { Hono } from "hono";
import {
  startBrowserServer,
  stopBrowserServer,
  getBrowserServerStatus,
} from "../services/browser-server.service";

const browserServerRoutes = new Hono();

browserServerRoutes.post("/browser-server/start", async (c) => {
  const { browserPath } = await c.req.json<{ browserPath: string }>();
  if (!browserPath) return c.json({ error: "browserPath required" }, 400);

  try {
    const result = await startBrowserServer(browserPath);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to start" }, 500);
  }
});

browserServerRoutes.post("/browser-server/stop", (c) => {
  stopBrowserServer();
  return c.json({ success: true });
});

browserServerRoutes.get("/browser-server/status", (c) => {
  return c.json(getBrowserServerStatus());
});

export default browserServerRoutes;
