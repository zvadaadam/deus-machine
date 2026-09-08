import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import routes from "../../../src/routes/provider-accounts";
import { errorHandler } from "../../../src/middleware/error-handler";
import {
  getCloudConfig,
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const app = new Hono().route("/api", routes).onError(errorHandler);
const fetchMock = vi.fn();
beforeEach(() => {
  resetCloudConfigForTests();
  vi.stubEnv("DEUS_CLOUD_AGNT_API_KEY", "");
  vi.stubEnv("AGNT_API_KEY", "");
  setCloudRuntimeCredentials({
    deusCloudUrl: "https://cloud.test",
    deusCloudSessionToken: "private-workos-bearer",
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider account proxy", () => {
  it("requires a signed-in cloud identity before forwarding", async () => {
    setCloudRuntimeCredentials({ deusCloudSessionToken: null });
    const response = await app.request("/api/settings/provider-accounts");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("manages personal accounts without a provisioned VM key, using only the backend's bearer", async () => {
    // The Deus login can succeed while its separate device-key mint fails.
    expect(getCloudConfig()).toBeNull();
    fetchMock.mockResolvedValue(
      new Response('{"providers":[],"accounts":[],"defaultAccountIds":{}}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "sensitive",
          authorization: "upstream-secret",
        },
      })
    );
    const response = await app.request(
      "/api/settings/provider-accounts?url=https://attacker.test",
      {
        headers: { authorization: "Bearer renderer-value" },
      }
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cloud.test/me/provider-accounts");
    expect(options.headers.authorization).toBe("Bearer private-workos-bearer");
    expect(options.redirect).toBe("manual");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("bearer");
  });

  it.each([
    ["POST", "", { provider: "claude", authMethod: "api_key", secret: "test-key", label: "Team" }],
    [
      "POST",
      "",
      { provider: "claude", authMethod: "subscription", secret: "test-token", label: "Personal" },
    ],
    [
      "POST",
      "",
      {
        provider: "codex",
        authMethod: "api_key",
        secret: "replacement-key",
        replaceAccountId: "account-1",
      },
    ],
    ["POST", "/logins", { provider: "codex", label: "Work", replaceAccountId: "account-1" }],
    ["PATCH", "/account-1", { isDefault: true }],
    ["DELETE", "/account-1", undefined],
    ["DELETE", "/logins/login-1", undefined],
  ])("forwards %s %s without accepting arbitrary proxy paths", async (method, path, body) => {
    fetchMock.mockResolvedValue(
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } })
    );
    const response = await app.request(`/api/settings/provider-accounts${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://cloud.test/me/provider-accounts${path}`);
    const forwardedBody = fetchMock.mock.calls[0][1].body;
    expect(forwardedBody === undefined ? undefined : JSON.parse(forwardedBody)).toEqual(body);
  });

  it("rejects raw subscription credentials and unknown methods instead of forwarding them", async () => {
    const response = await app.request("/api/settings/provider-accounts/logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authJson: "private token data" }),
    });
    expect(response.status).toBe(400);
    expect(
      (await app.request("/api/settings/provider-accounts/anything", { method: "POST" })).status
    ).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "cursor", authMethod: "api_key", secret: "sensitive-key" },
    { provider: "codex", authMethod: "unknown", secret: "sensitive-key" },
    {
      provider: "claude",
      authMethod: "api_key",
      secret: "sensitive-key",
      baseUrl: "https://attacker.test",
    },
  ])("rejects unsupported API-key inputs without echoing the key", async (input) => {
    const response = await app.request("/api/settings/provider-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("sensitive-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves cloud rejection status and actionable error messages", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        '{"error":"identity_mismatch","message":"Sign in with the original ChatGPT account."}',
        {
          status: 409,
          headers: { "content-type": "application/json" },
        }
      )
    );
    const response = await app.request("/api/settings/provider-accounts/logins/login-1/events");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "identity_mismatch",
      message: "Sign in with the original ChatGPT account.",
    });
  });

  it("streams immediately and propagates cancellation to the upstream body and request", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(":keepalive\n\n"));
      },
      cancel: cancelled,
    });
    fetchMock.mockResolvedValue(
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    );
    const controller = new AbortController();
    const response = await app.request(
      new Request("http://localhost/api/settings/provider-accounts/logins/login-1/events", {
        signal: controller.signal,
      })
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(":keepalive\n\n");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await reader.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
