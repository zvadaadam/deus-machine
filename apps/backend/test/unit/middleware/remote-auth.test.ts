import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock auth service
const mockValidateDeviceToken = vi.fn();
const mockUpdateLastSeen = vi.fn();
const mockCheckRateLimit = vi.fn(() => 0);

vi.mock("../../../src/services/remote-auth.service", () => ({
  validateDeviceToken: (...args: unknown[]) => mockValidateDeviceToken(...args),
  updateLastSeen: (...args: unknown[]) => mockUpdateLastSeen(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Mock settings service for remote-gate
const mockGetAllSettings = vi.fn(() => ({}));

vi.mock("../../../src/services/settings.service", () => ({
  getAllSettings: () => mockGetAllSettings(),
}));

import { authMiddleware } from "../../../src/middleware/remote-auth";
import {
  remoteGateMiddleware,
  invalidateRemoteGateCache,
} from "../../../src/middleware/remote-gate";

function createTestApp(middleware: any) {
  const app = new Hono();
  app.use("*", middleware);
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/remote-auth/pair", (c) => c.json({ paired: true }));
  app.get("/api/workspaces", (c) => c.json({ workspaces: [] }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRemoteGateCache();
});

// ---- Auth Middleware ----

describe("authMiddleware", () => {
  const app = createTestApp(authMiddleware);

  it("passes localhost requests without auth", async () => {
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
    expect(mockValidateDeviceToken).not.toHaveBeenCalled();
  });

  it("passes localhost ::1 without auth", async () => {
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "::1" },
    });
    expect(res.status).toBe(200);
  });

  it("passes localhost ::ffff:127.0.0.1 without auth", async () => {
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "::ffff:127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  it("passes public paths without auth", async () => {
    const res = await app.request("/api/health", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(200);
  });

  it("passes /api/remote-auth/pair without auth", async () => {
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for remote request without Bearer token", async () => {
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 for invalid token", async () => {
    mockValidateDeviceToken.mockReturnValue(null);
    const res = await app.request("/api/workspaces", {
      headers: {
        "x-forwarded-for": "192.168.1.50",
        authorization: "Bearer invalid-token",
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or revoked token");
  });

  it("passes with valid Bearer token", async () => {
    mockValidateDeviceToken.mockReturnValue({
      id: "dev1",
      name: "Phone",
      token_hash: "abc123",
    });
    const res = await app.request("/api/workspaces", {
      headers: {
        "x-forwarded-for": "192.168.1.50",
        authorization: "Bearer valid-token",
      },
    });
    expect(res.status).toBe(200);
    expect(mockUpdateLastSeen).toHaveBeenCalledWith("abc123");
  });

  it("returns 429 when rate-limited", async () => {
    mockCheckRateLimit.mockReturnValue(60_000);
    const res = await app.request("/api/workspaces", {
      headers: {
        "x-forwarded-for": "192.168.1.50",
        authorization: "Bearer some-token",
      },
    });
    expect(res.status).toBe(429);
  });
});

// ---- Remote Gate Middleware ----

describe("remoteGateMiddleware", () => {
  const app = createTestApp(remoteGateMiddleware);

  it("passes localhost when remote is disabled", async () => {
    mockGetAllSettings.mockReturnValue({ remote_access_enabled: false });
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects remote IP when remote is disabled", async () => {
    mockGetAllSettings.mockReturnValue({ remote_access_enabled: false });
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Remote access is not enabled");
  });

  it("passes remote IP when remote is enabled", async () => {
    mockGetAllSettings.mockReturnValue({ remote_access_enabled: true });
    const res = await app.request("/api/workspaces", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(res.status).toBe(200);
  });
});
