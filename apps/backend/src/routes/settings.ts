import { Hono } from "hono";
import { getAllSettings, saveSetting } from "../services/settings.service";
import { parseBody, SaveSettingBody } from "../lib/schemas";
import { ensureRelayConnected, disconnectFromRelay } from "../services/relay.service";

const app = new Hono();

app.get("/settings", (c) => {
  return c.json(getAllSettings());
});

app.post("/settings", async (c) => {
  const { key, value } = parseBody(SaveSettingBody, await c.req.json());
  saveSetting(key, value);

  if (key === "remote_access_enabled") {
    if (value === true) {
      ensureRelayConnected();
    } else {
      disconnectFromRelay();
    }
  }

  return c.json({ success: true, key, value });
});

export default app;
