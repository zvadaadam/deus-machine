import { Hono } from "hono";
import { AppError } from "../lib/errors";
import { getDeusCloudSessionConfig } from "../services/agent/cloud/config";
import { requestCloudSettings } from "../services/cloud-settings.service";

const app = new Hono<{ Bindings: { relayBridged?: boolean }; Variables: { device?: unknown } }>();
const prefix = "/settings/slack";

app.use(`${prefix}/*`, async (c, next) => {
  // Paired-device authority is not the desktop owner's WorkOS identity.
  if (c.env?.relayBridged || c.get("device"))
    throw new AppError(403, "Manage Slack using your own Deus Cloud sign-in.");
  c.header("cache-control", "no-store");
  await next();
});

function organizationId(c: { req: { query: (name: string) => string | undefined } }): string {
  const id = c.req.query("organizationId");
  if (!id) throw new AppError(400, "organizationId is required.");
  return id;
}

function validateSlackInstallUrl(value: unknown): void {
  if (typeof value !== "string") throw new AppError(502, "Slack returned an invalid link.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(502, "Slack returned an invalid link.");
  }
  const cloudUrl = getDeusCloudSessionConfig().deusCloudUrl;
  if (!cloudUrl) throw new AppError(503, "Deus Cloud is not configured.");
  if (url.origin !== new URL(cloudUrl).origin || url.pathname !== "/slack/install") {
    throw new AppError(502, "Slack returned an invalid link.");
  }
}

async function readDescriptionBody(request: { json: () => Promise<unknown> }) {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, "description")
  ) {
    throw new AppError(400, "description must be a string or null.");
  }
  const description = (body as { description: unknown }).description;
  if (description !== null && (typeof description !== "string" || description.length > 1000)) {
    throw new AppError(400, "description must be a string or null.");
  }
  return { description };
}

app.get(`${prefix}/installations`, async (c) => {
  const orgId = organizationId(c);
  return c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(orgId)}/slack/installations`,
      { signal: c.req.raw.signal },
      "product"
    )
  );
});

app.get(`${prefix}/install-url`, async (c) => {
  const orgId = organizationId(c);
  const result = await requestCloudSettings(
    `/orgs/${encodeURIComponent(orgId)}/slack/install-url`,
    { signal: c.req.raw.signal },
    "product"
  );
  validateSlackInstallUrl((result as { url?: unknown }).url);
  return c.json(result);
});

app.delete(`${prefix}/installations/:installationId`, async (c) => {
  const orgId = organizationId(c);
  return c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(orgId)}/slack/installations/${encodeURIComponent(c.req.param("installationId"))}`,
      { method: "DELETE", signal: c.req.raw.signal },
      "product"
    )
  );
});

app.get(`${prefix}/organization`, async (c) => {
  const orgId = organizationId(c);
  return c.json(
    await requestCloudSettings(`/orgs/${encodeURIComponent(orgId)}`, {
      signal: c.req.raw.signal,
    })
  );
});

app.put(`${prefix}/company-model-account`, async (c) => {
  const orgId = organizationId(c);
  return c.json(
    await requestCloudSettings(`/orgs/${encodeURIComponent(orgId)}/company-model-account`, {
      method: "PUT",
      signal: c.req.raw.signal,
    })
  );
});

app.delete(`${prefix}/company-model-account`, async (c) => {
  const orgId = organizationId(c);
  return c.json(
    await requestCloudSettings(`/orgs/${encodeURIComponent(orgId)}/company-model-account`, {
      method: "DELETE",
      signal: c.req.raw.signal,
    })
  );
});

app.put(`${prefix}/environments/:environmentId/description`, async (c) => {
  const orgId = organizationId(c);
  const body = await readDescriptionBody(c.req);
  return c.json(
    await requestCloudSettings(
      `/orgs/${encodeURIComponent(orgId)}/environment-settings/environments/${encodeURIComponent(c.req.param("environmentId"))}/description`,
      { method: "PUT", body: JSON.stringify(body), signal: c.req.raw.signal }
    )
  );
});

export default app;
