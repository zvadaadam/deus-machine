import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import routes from "../../../src/routes/compute-usage";
import { errorHandler } from "../../../src/middleware/error-handler";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";
import { requestCloudSettings } from "../../../src/services/cloud-settings.service";

const fetchMock = vi.fn();
const app = new Hono().route("/api", routes).onError(errorHandler);
const url = "/api/settings/cloud/compute-usage?organizationId=org-a";

function pendingFetch(_input: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  resetCloudConfigForTests();
  setCloudRuntimeCredentials({
    baseUrl: "https://platform.test",
    deusCloudUrl: "https://product.test",
    deusCloudSessionToken: "human-session",
    apiKey: "organization-api-key",
    orgId: "org-a",
  });
  fetchMock
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ active_reservations: 2, concurrency_limit: 10 })
    );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
});

it("reads the organization's usage through a fixed dashboard path and the human session", async () => {
  const response = await app.request(`${url}&url=https://elsewhere.test`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ activeReservations: 2, concurrencyLimit: 10 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(fetchMock.mock.calls[0]).toEqual([
    "https://platform.test/dashboard/orgs/org-a/compute-usage",
    expect.objectContaining({
      headers: { authorization: "Bearer human-session", "content-type": "application/json" },
      redirect: "manual",
    }),
  ]);
});

it("requires organization selection and a human session even when the desktop has an SDK key", async () => {
  expect((await app.request("/api/settings/cloud/compute-usage")).status).toBe(400);
  setCloudRuntimeCredentials({ deusCloudSessionToken: null });
  expect((await app.request(url)).status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("never lends the owner's session to a paired device or relayed request", async () => {
  const paired = new Hono<{ Variables: { device?: unknown } }>()
    .use("*", async (c, next) => {
      c.set("device", { id: "paired" });
      await next();
    })
    .route("/api", routes)
    .onError(errorHandler);
  expect((await paired.request(url)).status).toBe(403);
  expect((await app.request(url, {}, { relayBridged: true })).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserves the cloud's membership rejection", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ message: "Organization access denied" }, { status: 403 })
  );
  const response = await app.request(url);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "Organization access denied" });
});

it("discards in-flight usage from an account that signed out", async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    })
  );
  const pending = app.request(url);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  setCloudRuntimeCredentials({ deusCloudSessionToken: null });
  finish(Response.json({ runtime_minutes: 999 }));
  expect((await pending).status).toBe(409);
});

it("reports an account change when sign-out aborts the pending fetch", async () => {
  fetchMock.mockImplementation(pendingFetch);
  const pending = app.request(url);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  setCloudRuntimeCredentials({ deusCloudSessionToken: null });

  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Your Deus account changed. Try again." });
});

it.each([200, 403])(
  "reports an account change when switching identity aborts an HTTP %s response body",
  async (status) => {
    const bodyRead = vi.fn();
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), {
            once: true,
          });
        },
      });
      const response = new Response(body, { status });
      const readJson = response.json.bind(response);
      response.json = () => {
        bodyRead();
        return readJson();
      };
      return response;
    });
    const pending = app.request(url);
    await vi.waitFor(() => expect(bodyRead).toHaveBeenCalledOnce());

    setCloudRuntimeCredentials({ deusCloudSessionToken: "other-human-session", orgId: "org-b" });

    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Your Deus account changed. Try again." });
  }
);

it("preserves a fetch failure when the account did not change", async () => {
  const error = new TypeError("network unavailable");
  fetchMock.mockRejectedValue(error);

  await expect(requestCloudSettings("/orgs/org-a/compute-usage")).rejects.toBe(error);
});

it("preserves a response parsing failure when the account did not change", async () => {
  fetchMock.mockResolvedValue(new Response("invalid JSON"));

  await expect(requestCloudSettings("/orgs/org-a/compute-usage")).rejects.toBeInstanceOf(
    SyntaxError
  );
});

it("preserves a caller abort when the account did not change", async () => {
  const controller = new AbortController();
  const error = new Error("caller cancelled");
  fetchMock.mockImplementation(pendingFetch);
  const pending = requestCloudSettings("/orgs/org-a/compute-usage", { signal: controller.signal });
  const rejected = expect(pending).rejects.toBe(error);
  controller.abort(error);

  await rejected;
});
