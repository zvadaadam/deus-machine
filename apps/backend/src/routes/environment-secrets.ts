import { Hono } from "hono";
import { toSnakeCaseKeys } from "@deus-hq/api";
import { AppError } from "../lib/errors";
import {
  getCloudSettingsOrganizations,
  requestCloudSettings,
} from "../services/cloud-settings.service";

const app = new Hono<{ Bindings: { relayBridged?: boolean }; Variables: { device?: unknown } }>();
const prefix = "/settings/environment-secrets";

app.use(`${prefix}/*`, async (c, next) => {
  // Paired-device authority is not the desktop owner's WorkOS identity.
  if (c.env?.relayBridged || c.get("device"))
    throw new AppError(403, "Manage cloud secrets using your own Deus Cloud sign-in.");
  c.header("cache-control", "no-store");
  await next();
});
app.get(`${prefix}/orgs`, async (c) => c.json(await getCloudSettingsOrganizations()));
for (const action of ["accessible-repos", "install-url"] as const) {
  app.get(`${prefix}/orgs/:orgId/github/${action}`, async (c) =>
    c.json(
      await requestCloudSettings(
        `/orgs/${encodeURIComponent(c.req.param("orgId"))}/github/${action}`,
        { signal: c.req.raw.signal },
        "product"
      )
    )
  );
}
app.get(`${prefix}/orgs/:orgId/github/environment`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/github/environment?repository=${encodeURIComponent(c.req.query("repository") ?? "")}`,
      { signal: c.req.raw.signal },
      "product"
    )
  )
);
app.post(`${prefix}/orgs/:orgId/environments`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings/environments`,
      { method: "POST", body: JSON.stringify(await c.req.json()), signal: c.req.raw.signal }
    ),
    201
  )
);
app.put(`${prefix}/orgs/:orgId/environments/:id`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings/environments/${encodeURIComponent(c.req.param("id"))}`,
      { method: "PUT", body: JSON.stringify(await c.req.json()), signal: c.req.raw.signal }
    )
  )
);
app.get(`${prefix}/orgs/:orgId`, async (c) => {
  const environmentId = c.req.query("environment_id");
  const query = environmentId ? `?environment_id=${encodeURIComponent(environmentId)}` : "";
  return c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings${query}`,
      { signal: c.req.raw.signal }
    )
  );
});
app.put(`${prefix}/orgs/:orgId/secrets/:name`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings/secrets/${encodeURIComponent(c.req.param("name"))}`,
      {
        method: "PUT",
        body: JSON.stringify(toSnakeCaseKeys(await c.req.json())),
        signal: c.req.raw.signal,
      }
    )
  )
);
app.post(`${prefix}/orgs/:orgId/secrets/import`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings/secrets/import`,
      { method: "POST", body: JSON.stringify(await c.req.json()), signal: c.req.raw.signal }
    )
  )
);
app.delete(`${prefix}/orgs/:orgId/secrets/:id`, async (c) =>
  c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(c.req.param("orgId"))}/environment-settings/secrets/${encodeURIComponent(c.req.param("id"))}`,
      { method: "DELETE", signal: c.req.raw.signal }
    )
  )
);
export default app;
