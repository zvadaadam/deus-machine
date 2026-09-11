import { Hono } from "hono";
import { AppError } from "../lib/errors";
import { requestCloudSettings } from "../services/cloud-settings.service";

const app = new Hono<{ Bindings: { relayBridged?: boolean }; Variables: { device?: unknown } }>();

app.get("/settings/cloud/compute-usage", async (c) => {
  if (c.env?.relayBridged || c.get("device"))
    throw new AppError(403, "View cloud usage using your own Deus Cloud sign-in.");
  const orgId = c.req.query("organizationId");
  if (!orgId) throw new AppError(400, "Choose an organization to view cloud usage.");
  c.header("cache-control", "no-store");
  return c.json(
    await requestCloudSettings(`/orgs/${encodeURIComponent(orgId)}/compute-usage`, {
      signal: c.req.raw.signal,
    })
  );
});

export default app;
