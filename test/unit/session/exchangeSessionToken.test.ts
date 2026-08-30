import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exchangeCloudSessionToken } from "@/features/session/cloud/exchangeSessionToken";

describe("exchangeCloudSessionToken", () => {
  const realFetch = global.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("POSTs to the dashboard exchange with the bearer + expires_in and returns the token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "jwt-abc", expires_in: 600 }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await exchangeCloudSessionToken({
      baseUrl: "https://api.agnt",
      sessionId: "sess-9",
      bearer: "dcs-token",
      expiresIn: 600,
    });

    expect(res).toEqual({ token: "jwt-abc", expiresIn: 600 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.agnt/dashboard/sessions/sess-9/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer dcs-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ expires_in: 600 }),
      })
    );
  });

  it("throws with the status on a non-2xx (e.g. the endpoint's 403)", async () => {
    global.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 })
    ) as unknown as typeof fetch;

    await expect(
      exchangeCloudSessionToken({ baseUrl: "https://api.agnt", sessionId: "sess-x", bearer: "dcs" })
    ).rejects.toThrow(/403/);
  });

  it("omits expires_in from the body when not provided", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "t", expires_in: 3600 }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await exchangeCloudSessionToken({ baseUrl: "https://b", sessionId: "s", bearer: "d" });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(JSON.stringify({}));
  });
});
