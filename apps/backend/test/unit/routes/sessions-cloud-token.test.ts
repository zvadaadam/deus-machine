import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const { mockGetSessionRaw, mockGetCloudConfig, mockCreateSessionToken } = vi.hoisted(() => ({
  mockGetSessionRaw: vi.fn(),
  mockGetCloudConfig: vi.fn(),
  mockCreateSessionToken: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock("../../../src/db", () => ({
  getSessionRaw: mockGetSessionRaw,
  getAllSessions: vi.fn(),
  getSessionById: vi.fn(),
  getCompactions: vi.fn(),
  getMessages: vi.fn(),
  hasOlderMessages: vi.fn(),
  hasNewerMessages: vi.fn(),
  attachParts: vi.fn(),
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/agent/cloud/config")>()),
  // The workspace-init service registers its pre-connect refresh at import.
  setCloudConnectHook: () => {},
  getCloudConfig: mockGetCloudConfig,
  getCloudConnectionIdentity: (config?: unknown) => JSON.stringify(config ?? mockGetCloudConfig()),
}));
vi.mock("@deus-hq/sdk", () => ({ createSessionToken: mockCreateSessionToken }));

import app from "../../../src/routes/sessions";
import { errorHandler } from "../../../src/middleware/error-handler";

const wrapped = new Hono();
wrapped.route("/", app);
wrapped.onError(errorHandler);

describe("GET /sessions/:id/cloud-direct-token (the Mac-up token seam)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("uses the product session's actor and returns the actual token lifetime", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue({
      apiKey: "shared-org-key",
      baseUrl: "https://api.agnt",
      deusCloudSessionToken: "alice",
    });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "alice-token", expires_in: 600 }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await wrapped.request("/sessions/s1/cloud-direct-token");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: "alice-token", expires_in: 600 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.agnt/dashboard/sessions/prov-1/token",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer alice" }),
      })
    );
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it.each([401, 403])("returns product exchange %s without trying the org key", async (status) => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue({
      apiKey: "shared-org-key",
      baseUrl: "https://api.agnt",
      deusCloudSessionToken: "alice",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status }))
    );
    expect((await wrapped.request("/sessions/s1/cloud-direct-token")).status).toBe(status);
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("does not return a token exchanged before an account switch", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    const config = {
      apiKey: "shared-org-key",
      baseUrl: "https://api.agnt",
      deusCloudSessionToken: "alice",
    };
    mockGetCloudConfig.mockReturnValue(config);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        mockGetCloudConfig.mockReturnValue({ ...config, deusCloudSessionToken: "bob" });
        return new Response(JSON.stringify({ token: "alice-token", expires_in: 3600 }));
      })
    );
    const response = await wrapped.request("/sessions/s1/cloud-direct-token");
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("alice-token");
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("requires a product sign-in even when the device has an org key", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue({
      apiKey: "agnt_sk_x",
      baseUrl: "https://api.agnt",
      orgId: "org",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await wrapped.request("/sessions/s1/cloud-direct-token");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Sign in to Deus Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("404 when the session is unknown", async () => {
    mockGetSessionRaw.mockReturnValue(undefined);
    expect((await wrapped.request("/sessions/x/cloud-direct-token")).status).toBe(404);
  });

  it("400 when the session is not a cloud session (no provider_session_id)", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: null });
    expect((await wrapped.request("/sessions/s1/cloud-direct-token")).status).toBe(400);
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("400 when cloud is not configured on this device", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue(null);
    expect((await wrapped.request("/sessions/s1/cloud-direct-token")).status).toBe(400);
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });
});
