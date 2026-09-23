import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import routes from "../../../src/routes/slack";
import { errorHandler } from "../../../src/middleware/error-handler";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const fetchMock = vi.fn();
const app = new Hono().route("/api", routes).onError(errorHandler);

beforeEach(() => {
  resetCloudConfigForTests();
  setCloudRuntimeCredentials({
    baseUrl: "https://platform.test",
    deusCloudUrl: "https://product.test",
    deusCloudSessionToken: "human-session",
    apiKey: "organization-api-key",
    orgId: "org",
  });
  fetchMock.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
});

it("requires organization selection and blocks paired-device or relayed access", async () => {
  expect((await app.request("/api/settings/slack/installations")).status).toBe(400);

  const paired = new Hono<{ Variables: { device?: unknown } }>()
    .use("*", async (c, next) => {
      c.set("device", { id: "paired" });
      await next();
    })
    .route("/api", routes)
    .onError(errorHandler);
  expect(
    (await paired.request("/api/settings/slack/installations?organizationId=org")).status
  ).toBe(403);
  expect(
    (
      await app.request(
        "/api/settings/slack/installations?organizationId=org",
        {},
        { relayBridged: true }
      )
    ).status
  ).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  {
    method: "GET",
    url: "/api/settings/slack/installations?organizationId=org%2Fa&url=https://elsewhere.test",
    upstream: "https://product.test/orgs/org%2Fa/slack/installations",
    forwardedMethod: undefined,
  },
  {
    method: "DELETE",
    url: "/api/settings/slack/installations/inst%2Fone?organizationId=org",
    upstream: "https://product.test/orgs/org/slack/installations/inst%2Fone",
    forwardedMethod: "DELETE",
  },
  {
    method: "GET",
    url: "/api/settings/slack/organization?organizationId=org",
    upstream: "https://platform.test/dashboard/orgs/org",
    forwardedMethod: undefined,
  },
  {
    method: "PUT",
    url: "/api/settings/slack/company-model-account?organizationId=org",
    upstream: "https://platform.test/dashboard/orgs/org/company-model-account",
    forwardedMethod: "PUT",
  },
  {
    method: "DELETE",
    url: "/api/settings/slack/company-model-account?organizationId=org",
    upstream: "https://platform.test/dashboard/orgs/org/company-model-account",
    forwardedMethod: "DELETE",
  },
])(
  "forwards $method $url to a fixed upstream path",
  async ({ method, url, upstream, forwardedMethod }) => {
    const response = await app.request(url, { method });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock.mock.calls[0]).toEqual([
      upstream,
      expect.objectContaining({
        ...(forwardedMethod ? { method: forwardedMethod } : {}),
        headers: { authorization: "Bearer human-session", "content-type": "application/json" },
        redirect: "manual",
      }),
    ]);
  }
);

it("validates the install URL origin and path before returning it", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ url: "https://product.test/slack/install?state=abc" })
  );
  expect((await app.request("/api/settings/slack/install-url?organizationId=org")).status).toBe(
    200
  );
  expect(fetchMock.mock.calls[0][0]).toBe("https://product.test/orgs/org/slack/install-url");

  fetchMock.mockResolvedValue(Response.json({ url: "https://elsewhere.test/slack/install" }));
  expect((await app.request("/api/settings/slack/install-url?organizationId=org")).status).toBe(
    502
  );

  fetchMock.mockResolvedValue(Response.json({ url: "https://product.test/not-slack" }));
  expect((await app.request("/api/settings/slack/install-url?organizationId=org")).status).toBe(
    502
  );
});

it("validates description bodies before forwarding", async () => {
  const valid = await app.request(
    "/api/settings/slack/environments/env%2Fone/description?organizationId=org",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "backend API" }),
    }
  );
  expect(valid.status).toBe(200);
  expect(fetchMock.mock.calls[0]).toEqual([
    "https://platform.test/dashboard/orgs/org/environment-settings/environments/env%2Fone/description",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ description: "backend API" }),
    }),
  ]);

  for (const body of [
    {},
    { description: 1 },
    { description: "x", extra: true },
    { description: "x".repeat(1001) },
  ]) {
    fetchMock.mockClear();
    const response = await app.request(
      "/api/settings/slack/environments/env/description?organizationId=org",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  }
});

it("preserves upstream cloud error codes in response details", async () => {
  fetchMock.mockResolvedValue(
    Response.json(
      { message: "Connect a Claude account first", code: "NO_PROVIDER_ACCOUNT" },
      { status: 409 }
    )
  );
  const response = await app.request(
    "/api/settings/slack/company-model-account?organizationId=org",
    { method: "PUT" }
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "Connect a Claude account first",
    details: { code: "NO_PROVIDER_ACCOUNT" },
  });
});
