import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "@shared/api/sessions";
import { operations } from "../../helpers";

const { mockGetSessionRaw, mockGetCloudConfig, mockCreateSessionToken } = vi.hoisted(() => ({
  mockGetSessionRaw: vi.fn(),
  mockGetCloudConfig: vi.fn(),
  mockCreateSessionToken: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock("../../../src/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db")>()),
  getSessionRaw: mockGetSessionRaw,
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

import sessionHandlers from "../../../src/api/sessions";

const run = operations(sessionHandlers);
const token = (sessionId = "s1") => run(api.cloudDirectToken, { sessionId });

describe("cloudDirectToken (a client's own channel to a cloud chat)", () => {
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
    expect(await token()).toMatchObject({
      token: "alice-token",
      expires_in: 600,
      base_url: "https://api.agnt",
      provider_session_id: "prov-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.agnt/dashboard/sessions/prov-1/token",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer alice" }),
      })
    );
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "refuses with the exchange's %s without trying the org key",
    async (status) => {
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
      await expect(token()).rejects.toMatchObject({ statusCode: status });
      expect(mockCreateSessionToken).not.toHaveBeenCalled();
    }
  );

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
    const refusal = await token().catch((error: Error & { statusCode?: number }) => error);
    expect(refusal).toMatchObject({ statusCode: 409 });
    expect(JSON.stringify(refusal)).not.toContain("alice-token");
    expect((refusal as Error).message).not.toContain("alice-token");
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
    await expect(token()).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("Sign in to Deus Cloud"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    mockGetSessionRaw.mockReturnValue(undefined);
    await expect(token("x")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a session that is not a cloud session (no provider_session_id)", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: null });
    await expect(token()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it("refuses when cloud is not configured on this device", async () => {
    mockGetSessionRaw.mockReturnValue({ id: "s1", provider_session_id: "prov-1" });
    mockGetCloudConfig.mockReturnValue(null);
    await expect(token()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });
});
