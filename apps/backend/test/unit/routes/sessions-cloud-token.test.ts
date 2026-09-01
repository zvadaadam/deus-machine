import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.mock("../../../src/services/agent/cloud/config", () => ({ getCloudConfig: mockGetCloudConfig }));
vi.mock("@deus-hq/sdk", () => ({ createSessionToken: mockCreateSessionToken }));

import app from "../../../src/routes/sessions";
import { errorHandler } from "../../../src/middleware/error-handler";

const wrapped = new Hono();
wrapped.route("/", app);
wrapped.onError(errorHandler);

describe("GET /sessions/:id/cloud-direct-token (the Mac-up token seam)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints a session-scoped token for a cloud session via the cloud creds", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue({
      apiKey: "agnt_sk_x",
      baseUrl: "https://api.agnt",
      orgId: "org",
    });
    mockCreateSessionToken.mockResolvedValue({ token: "jwt-tok", expiresIn: 3600 });

    const res = await wrapped.request("/sessions/s1/cloud-direct-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: "jwt-tok",
      base_url: "https://api.agnt",
      provider_session_id: "prov-1",
      expires_in: 3600,
    });
    expect(mockCreateSessionToken).toHaveBeenCalledWith(
      "prov-1",
      expect.objectContaining({ apiKey: "agnt_sk_x", baseUrl: "https://api.agnt" })
    );
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
