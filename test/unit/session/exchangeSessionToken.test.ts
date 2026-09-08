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

  it("terminates a stalled exchange at its 15-second deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    global.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
        })
    );

    const request = exchangeCloudSessionToken({
      baseUrl: "https://api.agnt",
      sessionId: "sess-9",
      bearer: "dcs-token",
    });
    expect(timeout).toHaveBeenCalledWith(15_000);
    const rejected = expect(request).rejects.toThrow("Request deadline elapsed");
    deadline.abort(new Error("Request deadline elapsed"));
    await rejected;
  });

  it("omits expires_in from the body when not provided", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "t", expires_in: 3600 }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await exchangeCloudSessionToken({ baseUrl: "https://b", sessionId: "s", bearer: "d" });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(JSON.stringify({}));
  });

  it("keeps a supplied session id inside its one route and rejects redirects", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "t", expires_in: 3600 }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await exchangeCloudSessionToken({
      baseUrl: "https://api.agnt/",
      sessionId: "../other?secret=1",
      bearer: "dcs",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.agnt/dashboard/sessions/..%2Fother%3Fsecret%3D1/token",
      expect.objectContaining({ redirect: "error" })
    );
  });

  it.each(["http://api.agnt", "http://localhost.evil.test", "ftp://localhost"])(
    "rejects insecure endpoint %s before sending the bearer",
    async (baseUrl) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;
      await expect(
        exchangeCloudSessionToken({ baseUrl, sessionId: "session-1", bearer: "private-bearer" })
      ).rejects.toThrow(/HTTPS/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["http://127.0.0.1:8788", "http://localhost:8788", "http://[::1]:8788"])(
    "allows explicit loopback endpoint %s for local development",
    async (baseUrl) => {
      const fetchMock = vi.fn(async () => new Response('{"token":"local-token"}'));
      global.fetch = fetchMock;
      await expect(
        exchangeCloudSessionToken({ baseUrl, sessionId: "session-1", bearer: "local-bearer" })
      ).resolves.toMatchObject({ token: "local-token" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/dashboard/sessions/session-1/token`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer local-bearer" }),
        })
      );
    }
  );

  it.each([null, {}, { token: "" }])("does not return malformed token payload %j", async (body) => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    await expect(
      exchangeCloudSessionToken({ baseUrl: "https://b", sessionId: "s", bearer: "d" })
    ).rejects.toThrow("no token");
  });
});
