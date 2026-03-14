/**
 * Integration tests for the remote access auth pipeline.
 *
 * These tests exercise the FULL middleware chain + routes + services
 * with a real in-memory SQLite database. Nothing is mocked except:
 *   - getDatabase() (returns our test-local in-memory DB)
 *   - getServerPort() (health.ts imports server.ts which has side effects)
 *
 * What this proves that unit tests can't:
 *   - Middleware ordering: remote-gate -> CORS -> auth -> route handlers
 *   - Real SHA-256 hashing: createDeviceToken() stores hash, validateDeviceToken() finds it
 *   - Real Zod validation: PairBody schema rejects malformed requests
 *   - Settings cache invalidation: toggling remote_access_enabled actually gates access
 *   - One-time pairing codes: generate -> use -> refuse reuse
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// ---- Hoisted setup: create DB in vi.hoisted scope so vi.mock can reference it ----

const { testDb, TEST_DB_PATH, TEST_DIR } = vi.hoisted(() => {
  // Import better-sqlite3 synchronously in the hoisted block.
  // vi.hoisted runs before any vi.mock factory but after module imports are resolved.
  const Database = require("better-sqlite3");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  // Use a real temp directory so PREFS_PATH (derived from DB_PATH) resolves correctly.
  // Settings are now stored in preferences.json, not the settings DB table.
  const testDir = path.join(os.tmpdir(), `opendevs-test-auth-flow-${process.pid}-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const dbPath = path.join(testDir, "opendevs.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return { testDb: db, TEST_DB_PATH: dbPath, TEST_DIR: testDir };
});

// Mock getDatabase to return our test DB.
// This must be vi.mock (hoisted) so every module that imports getDatabase gets the test DB.
vi.mock("../../src/lib/database", () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  closeDatabase: () => {},
  DB_PATH: TEST_DB_PATH,
}));

// Mock server.ts to prevent side-effect execution (it calls initDatabase + serve at import time).
// health.ts imports getServerPort from server.ts, which triggers the entire server boot.
vi.mock("../../src/server", () => ({
  getServerPort: () => 0,
}));

// Now import everything (after mocks are hoisted)
import fs from "fs";
import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";
import { createApp } from "../../src/app";
import { _clearAll as clearAuthState } from "../../src/services/auth.service";
import { invalidateRemoteGateCache } from "../../src/middleware/remote-gate";
import { closeAll as closeAllWs } from "../../src/services/ws.service";
import { saveSetting, PREFS_PATH } from "../../src/services/settings.service";

// Headers that simulate a remote client (non-localhost IP)
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.50" };
const LOCAL_HEADERS = { "x-forwarded-for": "127.0.0.1" };

let app: ReturnType<typeof createApp>["app"];

beforeAll(() => {
  // Create all tables in the test DB
  testDb.exec(SCHEMA_SQL);
  ({ app } = createApp());
});

beforeEach(() => {
  // Clean slate for each test: clear in-memory auth state + DB rows + preferences + caches
  clearAuthState();
  invalidateRemoteGateCache();
  testDb.exec("DELETE FROM paired_devices");
  // Settings live in preferences.json now (settings table was removed)
  try { fs.unlinkSync(PREFS_PATH); } catch {}
});

afterAll(() => {
  closeAllWs();
  testDb.close();
  // Clean up temp directory
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// ---- Helpers ----

/** Enable remote access in settings (writes preferences.json). */
function enableRemoteAccess() {
  saveSetting("remote_access_enabled", true);
  invalidateRemoteGateCache();
}

/** Disable remote access in settings. */
function disableRemoteAccess() {
  saveSetting("remote_access_enabled", false);
  invalidateRemoteGateCache();
}

/** Generate a pairing code from localhost. Returns the code string. */
async function generateCode(): Promise<string> {
  const res = await app.request("/api/remote-auth/generate-pair-code", {
    method: "POST",
    headers: LOCAL_HEADERS,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.code;
}

/** Pair a device using a code. Returns { token, device }. */
async function pairDevice(code: string, deviceName = "Test Device"): Promise<{ token: string; device: { id: string; name: string } }> {
  const res = await app.request("/api/remote-auth/pair", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...REMOTE_HEADERS,
    },
    body: JSON.stringify({ code, deviceName }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Remote Gate: access control", () => {
  it("allows localhost requests when remote access is disabled", async () => {
    disableRemoteAccess();
    const res = await app.request("/api/health", { headers: LOCAL_HEADERS });
    expect(res.status).toBe(200);
  });

  it("rejects remote requests when remote access is disabled", async () => {
    disableRemoteAccess();
    const res = await app.request("/api/health", { headers: REMOTE_HEADERS });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Remote access is not enabled");
  });

  it("allows remote requests when remote access is enabled", async () => {
    enableRemoteAccess();
    // Health is a public path, so it should pass both gate + auth
    const res = await app.request("/api/health", { headers: REMOTE_HEADERS });
    expect(res.status).toBe(200);
  });
});

describe("Full pairing flow: generate code -> pair -> use token", () => {
  beforeEach(() => {
    enableRemoteAccess();
  });

  it("generates a WORD-NNNN code from localhost", async () => {
    const code = await generateCode();
    expect(code).toMatch(/^[A-Z]+-\d{4}$/);
  });

  it("rejects code generation from remote IP", async () => {
    const res = await app.request("/api/remote-auth/generate-pair-code", {
      method: "POST",
      headers: REMOTE_HEADERS,
    });
    // Remote gate passes (enabled), auth middleware skips (public? no -- this path is NOT public).
    // Actually /auth/generate-pair-code is NOT in PUBLIC_PATHS, so auth middleware will require a token.
    // But the route itself also checks requireLocalhost. So remote gets 401 from auth middleware first.
    expect(res.status).toBe(401);
  });

  it("exchanges a valid code for a device token", async () => {
    const code = await generateCode();
    const { token, device } = await pairDevice(code);

    expect(token).toHaveLength(64); // 32 bytes hex
    expect(device.id).toBeTruthy();
    expect(device.name).toBe("Test Device");
  });

  it("uses the token to access a protected endpoint", async () => {
    const code = await generateCode();
    const { token } = await pairDevice(code);

    // Use /api/settings (not in PUBLIC_PATHS) to prove token auth works end-to-end
    const res = await app.request("/api/settings", {
      headers: {
        ...REMOTE_HEADERS,
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a reused pairing code", async () => {
    const code = await generateCode();
    await pairDevice(code); // First use succeeds

    // Second use fails
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...REMOTE_HEADERS,
      },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired pairing code");
  });

  it("rejects an invalid token on protected endpoints", async () => {
    // Must use a non-public path — /api/health is in PUBLIC_PATHS and skips auth
    const res = await app.request("/api/workspaces", {
      headers: {
        ...REMOTE_HEADERS,
        authorization: "Bearer totally-fake-token-that-does-not-exist",
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or revoked token");
  });

  it("rejects requests with no token on protected endpoints", async () => {
    const res = await app.request("/api/workspaces", {
      headers: REMOTE_HEADERS,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });
});

describe("Device management: list, revoke, verify revocation", () => {
  beforeEach(() => {
    enableRemoteAccess();
  });

  it("lists paired devices from localhost", async () => {
    const code = await generateCode();
    await pairDevice(code, "My Phone");

    const res = await app.request("/api/remote-auth/devices", { headers: LOCAL_HEADERS });
    expect(res.status).toBe(200);
    const { devices } = await res.json();
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe("My Phone");
    // token_hash must never be exposed
    expect(devices[0]).not.toHaveProperty("token_hash");
  });

  it("revokes a device and the token stops working", async () => {
    const code = await generateCode();
    const { token, device } = await pairDevice(code);

    // Verify token works before revocation (use non-public path to exercise auth)
    const before = await app.request("/api/workspaces", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });
    // May be 200 or 500 depending on DB state, but NOT 401
    expect(before.status).not.toBe(401);

    // Revoke the device
    const revokeRes = await app.request(`/api/remote-auth/devices/${device.id}`, {
      method: "DELETE",
      headers: LOCAL_HEADERS,
    });
    expect(revokeRes.status).toBe(200);

    // Token should no longer work
    const after = await app.request("/api/workspaces", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it("returns 404 when revoking a nonexistent device", async () => {
    const res = await app.request("/api/remote-auth/devices/does-not-exist", {
      method: "DELETE",
      headers: LOCAL_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("rejects device management from remote IPs", async () => {
    // /auth/devices is localhost-only, but auth middleware will reject first (no token)
    const res = await app.request("/api/remote-auth/devices", {
      headers: REMOTE_HEADERS,
    });
    expect(res.status).toBe(401);
  });
});

describe("Pairing validation: Zod schema enforcement", () => {
  beforeEach(() => {
    enableRemoteAccess();
  });

  it("rejects pair request with empty code", async () => {
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...REMOTE_HEADERS,
      },
      body: JSON.stringify({ code: "" }),
    });
    // Zod validation should fail with 400 (ValidationError via error handler)
    expect(res.status).toBe(400);
  });

  it("rejects pair request with no body", async () => {
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...REMOTE_HEADERS,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("accepts optional deviceName", async () => {
    const code = await generateCode();
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...REMOTE_HEADERS,
      },
      body: JSON.stringify({ code, deviceName: "Custom Name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device.name).toBe("Custom Name");
  });
});

describe("Rate limiting across the full stack", () => {
  beforeEach(() => {
    enableRemoteAccess();
  });

  it("locks out an IP after 10 failed pairing attempts", async () => {
    // Burn through 10 failures with bad codes
    for (let i = 0; i < 10; i++) {
      await app.request("/api/remote-auth/pair", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...REMOTE_HEADERS,
        },
        body: JSON.stringify({ code: `BAD-${String(i).padStart(4, "0")}` }),
      });
    }

    // 11th attempt should be rate-limited
    const res = await app.request("/api/remote-auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...REMOTE_HEADERS,
      },
      body: JSON.stringify({ code: "WOLF-9999" }),
    });
    expect(res.status).toBe(429);
  });

  it("rate limit applies to auth middleware too (protected endpoints)", async () => {
    // Exhaust rate limit
    for (let i = 0; i < 10; i++) {
      await app.request("/api/remote-auth/pair", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...REMOTE_HEADERS,
        },
        body: JSON.stringify({ code: `BAD-${String(i).padStart(4, "0")}` }),
      });
    }

    // Protected endpoint with valid-looking token should also be rate-limited
    const res = await app.request("/api/workspaces", {
      headers: {
        ...REMOTE_HEADERS,
        authorization: "Bearer some-token",
      },
    });
    expect(res.status).toBe(429);
  });
});

describe("Gate page: server-rendered HTML", () => {
  it("serves HTML at / for remote clients (when remote enabled)", async () => {
    enableRemoteAccess();
    const res = await app.request("/", { headers: REMOTE_HEADERS });
    // Remote gate passes, no auth on /, so we get the HTML
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connect to OpenDevs");
    expect(html).toContain("pair-form");
  });

  it("blocks gate page when remote access is disabled", async () => {
    disableRemoteAccess();
    const res = await app.request("/", { headers: REMOTE_HEADERS });
    expect(res.status).toBe(403);
  });

  it("serves gate page to localhost regardless of remote setting", async () => {
    disableRemoteAccess();
    const res = await app.request("/", { headers: LOCAL_HEADERS });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connect to OpenDevs");
  });
});

describe("Multiple devices: independent tokens", () => {
  beforeEach(() => {
    enableRemoteAccess();
  });

  it("each pairing creates an independent token", async () => {
    const code1 = await generateCode();
    const code2 = await generateCode();

    const { token: token1 } = await pairDevice(code1, "Phone");
    const { token: token2 } = await pairDevice(code2, "Tablet");

    // Both tokens should pass auth (use non-public path to exercise auth middleware)
    const res1 = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token1}` },
    });
    const res2 = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token2}` },
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Devices list should show both
    const listRes = await app.request("/api/remote-auth/devices", { headers: LOCAL_HEADERS });
    const { devices } = await listRes.json();
    expect(devices).toHaveLength(2);
  });

  it("revoking one device does not affect the other", async () => {
    const code1 = await generateCode();
    const code2 = await generateCode();

    const { token: token1, device: device1 } = await pairDevice(code1, "Phone");
    const { token: token2 } = await pairDevice(code2, "Tablet");

    // Revoke Phone
    await app.request(`/api/remote-auth/devices/${device1.id}`, {
      method: "DELETE",
      headers: LOCAL_HEADERS,
    });

    // Phone token dead (use non-public path to exercise auth middleware)
    const res1 = await app.request("/api/workspaces", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token1}` },
    });
    // Tablet token alive (also non-public path)
    const res2 = await app.request("/api/workspaces", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token2}` },
    });
    expect(res1.status).toBe(401);
    // Not 401 — auth passed, endpoint may return 200 or other non-auth error
    expect(res2.status).not.toBe(401);
  });
});
