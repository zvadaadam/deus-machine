import { Hono } from "hono";
import { createServer } from "node:http";
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
const nativeFetch = globalThis.fetch;
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
  vi.restoreAllMocks();
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

  it("does not send the bearer to a non-loopback HTTP endpoint", async () => {
    setCloudRuntimeCredentials({ deusCloudUrl: null });
    vi.stubEnv("DEUS_CLOUD_URL", "http://cloud.test");
    const response = await app.request("/api/settings/provider-accounts");
    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "/logins/login-1/events"])(
    "discards a late %s response when the Deus account changes",
    async (path) => {
      let finish!: (response: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
      );
      const pending = app.request(`/api/settings/provider-accounts${path}`);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      setCloudRuntimeCredentials({ deusCloudSessionToken: "other-account-bearer" });
      const cancelled = vi.fn();
      finish(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"email":"account-a@example.com"}'));
            },
            cancel: cancelled,
          })
        )
      );

      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Your Deus account changed. Try again." });
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledOnce();
    }
  );

  it("closes a live upstream event stream on account change", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(":keepalive\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      setCloudRuntimeCredentials({ deusCloudUrl: `http://127.0.0.1:${address.port}` });
      fetchMock.mockImplementation(nativeFetch);
      const response = await app.request("/api/settings/provider-accounts/logins/login-1/events");
      reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(":keepalive\n\n");
      const next = reader.read();
      setCloudRuntimeCredentials({ deusCloudSessionToken: "other-account-bearer" });
      await expect(next).rejects.toThrow();
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("manages personal accounts without a provisioned VM key, using only the backend's bearer", async () => {
    // The Deus login can succeed while its separate device-key mint fails.
    expect(getCloudConfig()).toBeNull();
    fetchMock.mockResolvedValue(
      new Response('{"providers":[],"accounts":[],"default_account_ids":{"claude":"account-1"}}', {
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
    expect(await response.json()).toEqual({
      providers: [],
      accounts: [],
      default_account_ids: { claude: "account-1" },
    });
  });

  it.each([
    ["POST", "", { provider: "claude", auth_method: "api_key", secret: "test-key", label: "Team" }],
    [
      "POST",
      "",
      { provider: "claude", auth_method: "subscription", secret: "test-token", label: "Personal" },
    ],
    [
      "POST",
      "",
      {
        provider: "codex",
        auth_method: "api_key",
        secret: "replacement-key",
        replace_account_id: "account-1",
      },
    ],
    ["POST", "/logins", { provider: "codex", label: "Work", replace_account_id: "account-1" }],
    ["PATCH", "/account-1", { is_default: true }],
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
    { provider: "cursor", auth_method: "api_key", secret: "sensitive-key" },
    { provider: "codex", auth_method: "unknown", secret: "sensitive-key" },
    {
      provider: "claude",
      auth_method: "api_key",
      secret: "sensitive-key",
      base_url: "https://attacker.test",
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

  it.each(["GET", "POST"])(
    "bounds stalled %s requests with a 15-second deadline",
    async (method) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      fetchMock.mockImplementation(
        (_url, { signal }: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
          })
      );
      const pending = app.request("/api/settings/provider-accounts", {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                provider: "claude",
                auth_method: "api_key",
                secret: "test-key",
              }),
            }
          : {}),
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(15_000);

      deadline.abort(new DOMException("Request timed out", "TimeoutError"));
      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Couldn't reach Deus Cloud. Try again." });
    }
  );

  it("retains caller cancellation on normal requests", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    const controller = new AbortController();
    await app.request(
      new Request("http://localhost/api/settings/provider-accounts", { signal: controller.signal })
    );
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("streams immediately and propagates cancellation to the upstream body and request", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
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
    expect(timeout).not.toHaveBeenCalled();
    controller.abort();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await reader.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
