import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock auth service
const mockGeneratePairCode = vi.fn<(...args: any[]) => any>(() => ({
  code: "SOFT TIGER",
  expiresAt: Date.now() + 900_000,
}));
const mockAuthorizePairing = vi.fn<(...args: any[]) => any>(() => null);
const mockCreateDeviceToken = vi.fn<(...args: any[]) => any>(() => ({
  token: "raw-token-hex",
  device: {
    id: "dev1",
    name: "My Phone",
    token_hash: "hidden",
    ip_address: null,
    user_agent: null,
    last_seen_at: "2025-01-01",
    created_at: "2025-01-01",
  },
}));
const mockListDevices = vi.fn<(...args: any[]) => any>(() => [
  {
    id: "dev1",
    name: "Phone",
    ip_address: null,
    user_agent: null,
    last_seen_at: "2025-01-01",
    created_at: "2025-01-01",
  },
]);
const mockRevokeDevice = vi.fn<(...args: any[]) => any>(() => true);

vi.mock("../../../src/services/remote-auth.service", () => ({
  generatePairCode: (...args: unknown[]) => mockGeneratePairCode(...args),
  authorizePairing: (...args: unknown[]) => mockAuthorizePairing(...args),
  createDeviceToken: (...args: unknown[]) => mockCreateDeviceToken(...args),
  listDevices: (...args: unknown[]) => mockListDevices(...args),
  revokeDevice: (...args: unknown[]) => mockRevokeDevice(...args),
}));

import authRoutes from "../../../src/routes/remote-auth";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizePairing.mockReturnValue(null);
  mockRevokeDevice.mockReturnValue(true);
});

describe("POST /remote-auth/pair", () => {
  it("returns token on valid code", async () => {
    const res = await authRoutes.request("/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.168.1.50",
      },
      body: JSON.stringify({ code: "SOFT TIGER" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("raw-token-hex");
    expect(mockAuthorizePairing).toHaveBeenCalledWith("SOFT TIGER", "192.168.1.50");
    expect(body.device.id).toBe("dev1");
    // token_hash should NOT be exposed
    expect(body.device).not.toHaveProperty("token_hash");
  });

  it("returns 401 on invalid code", async () => {
    mockAuthorizePairing.mockReturnValue("invalid_code");
    const res = await authRoutes.request("/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.168.1.50",
      },
      body: JSON.stringify({ code: "BAD-0000" }),
    });
    expect(res.status).toBe(401);
    expect(mockCreateDeviceToken).not.toHaveBeenCalled();
  });

  it("returns 429 when rate-limited", async () => {
    mockAuthorizePairing.mockReturnValue("rate_limited");
    const res = await authRoutes.request("/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.168.1.50",
      },
      body: JSON.stringify({ code: "SOFT TIGER" }),
    });
    expect(res.status).toBe(429);
  });
});

describe("POST /remote-auth/generate-pair-code", () => {
  it("returns code from localhost", async () => {
    const res = await authRoutes.request("/remote-auth/generate-pair-code", {
      method: "POST",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("SOFT TIGER");
    expect(body.expires_in_seconds).toBeGreaterThan(0);
  });

  it("rejects from remote IP", async () => {
    const res = await authRoutes.request("/remote-auth/generate-pair-code", {
      method: "POST",
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /remote-auth/devices", () => {
  it("returns devices from localhost", async () => {
    const res = await authRoutes.request("/remote-auth/devices", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
  });

  it("rejects from remote IP", async () => {
    const res = await authRoutes.request("/remote-auth/devices", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /remote-auth/devices/:id", () => {
  it("revokes device from localhost", async () => {
    const res = await authRoutes.request("/remote-auth/devices/dev1", {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 when device not found", async () => {
    mockRevokeDevice.mockReturnValue(false);
    const res = await authRoutes.request("/remote-auth/devices/nonexistent", {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects from remote IP", async () => {
    const res = await authRoutes.request("/remote-auth/devices/dev1", {
      method: "DELETE",
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(403);
  });
});
