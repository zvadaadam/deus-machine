import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import routes from "../../../src/routes/environment-secrets";
import { errorHandler } from "../../../src/middleware/error-handler";
import { getCloudWorkspaceUserId } from "../../../src/services/cloud-environment-settings.service";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const fetchMock = vi.fn();
const metadata = { account_id: "alice", items: [{ id: "org", name: "Org" }] };
beforeEach(() => {
  resetCloudConfigForTests();
  setCloudRuntimeCredentials({
    baseUrl: "https://platform.test",
    deusCloudUrl: "https://product.test",
    deusCloudSessionToken: "session-a",
    orgId: "org",
    apiKey: null,
  });
  fetchMock.mockReset().mockImplementation(async () => Response.json(metadata));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
});

describe("application secret forwarding", () => {
  const app = new Hono().route("/api", routes).onError(errorHandler);
  it("uses the signed-in session, including before device-key setup, and fixed upstream paths", async () => {
    const response = await app.request(
      "/api/settings/environment-secrets/orgs?url=https://elsewhere.test"
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountId: "alice",
      currentOrganizationId: "org",
      items: [{ id: "org", name: "Org" }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://platform.test/dashboard/orgs");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { authorization: "Bearer session-a" },
      redirect: "manual",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("derives workspace personal scope from the verified account and checks the active org", async () => {
    expect(await getCloudWorkspaceUserId()).toBe("alice");
    setCloudRuntimeCredentials({ orgId: "foreign" });
    await expect(getCloudWorkspaceUserId()).rejects.toThrow("organization changed");
  });
  it("requires a human session to manage secrets", async () => {
    setCloudRuntimeCredentials({ deusCloudSessionToken: null });
    expect((await app.request("/api/settings/environment-secrets/orgs")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("forwards GitHub discovery only to fixed product routes with the human session", async () => {
    const response = await app.request(
      "/api/settings/environment-secrets/orgs/org/github/accessible-repos?url=https://elsewhere.test"
    );
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://product.test/orgs/org/github/accessible-repos",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-a" }),
      }),
    ]);
  });
  it("forwards setup edits without interpreting script contents", async () => {
    const body = {
      setup: [{ commands: ["export SOME_KEY=value\nbun run prepare"], phase: "pre-clone" }],
    };
    const response = await app.request(
      "/api/settings/environment-secrets/orgs/org/environments/env",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://platform.test/dashboard/orgs/org/environment-settings/environments/env",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(body) }),
    ]);
  });
  it.each([401, 502])("preserves a non-JSON cloud error's HTTP status (%s)", async (status) => {
    fetchMock.mockResolvedValue(
      new Response(status === 401 ? null : "Gateway unavailable", { status })
    );
    const response = await app.request("/api/settings/environment-secrets/orgs");
    expect(response.status).toBe(status);
    expect((await response.json()).error).toBe("Couldn't load cloud environment settings.");
  });
  it("does not lend the desktop owner's session to paired clients or the relay", async () => {
    const paired = new Hono<{ Variables: { device?: unknown } }>()
      .use("*", async (c, next) => {
        c.set("device", { id: "paired" });
        await next();
      })
      .route("/api", routes)
      .onError(errorHandler);
    expect((await paired.request("/api/settings/environment-secrets/orgs")).status).toBe(403);
    expect(
      (await app.request("/api/settings/environment-secrets/orgs", {}, { relayBridged: true }))
        .status
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("discards a response belonging to an account that signed out during the request", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
    );
    const pending = app.request("/api/settings/environment-secrets/orgs");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    setCloudRuntimeCredentials({ deusCloudSessionToken: null });
    finish(Response.json(metadata));
    expect((await pending).status).toBe(409);
  });
});
