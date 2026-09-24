/**
 * Integration tests for the POST /settings ↔ remote-gate cache contract.
 *
 * These tests exercise the FULL middleware chain + routes + services with a
 * real in-memory SQLite database. Nothing is mocked except:
 *   - getDatabase() (returns our test-local in-memory DB)
 *   - getServerPort() (health.ts imports server.ts which has side effects)
 *   - relay.service (the cloud-relay WebSocket tunnel — we only care about the
 *     HTTP gate here; ensureRelayConnected()/disconnectFromRelay() are no-ops
 *     so we can drive the toggle through the REAL POST /settings route without
 *     attempting an outbound WebSocket connection to a cloud relay)
 *
 * What this proves that unit tests + auth-flow.test.ts can't:
 *   - The production POST /settings route invalidates the remote-gate TTL cache
 *     when remote_access_enabled is toggled, so direct non-localhost HTTP
 *     requests are admitted/rejected on the very next request — not up to
 *     CACHE_TTL_MS (5s) later.
 *   - The bug regression where the route mutated preferences.json + tore down
 *     the relay tunnel but left the gate's 5s cache serving the stale value.
 *
 * Note: auth-flow.test.ts deliberately BYPASSES the POST /settings route (it
 * calls saveSetting() directly + invalidateRemoteGateCache()) specifically to
 * avoid ensureRelayConnected()'s side effect. By mocking relay.service here,
 * these tests become the FIRST integration coverage of the real toggle route.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// ---- Hoisted setup: create DB in vi.hoisted scope so vi.mock can reference it ----

const { testDb, TEST_DB_PATH, TEST_DIR } = vi.hoisted(() => {
  const Database = require("better-sqlite3");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  const testDir = path.join(os.tmpdir(), `deus-test-settings-gate-${process.pid}-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const dbPath = path.join(testDir, "deus.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return { testDb: db, TEST_DB_PATH: dbPath, TEST_DIR: testDir };
});

// Mock getDatabase to return our test DB.
vi.mock("../../src/lib/database", () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  closeDatabase: () => {},
  DB_PATH: TEST_DB_PATH,
}));

// Mock server.ts to prevent side-effect execution (it calls initDatabase + serve at import time).
vi.mock("../../src/server", () => ({
  getServerPort: () => 0,
}));

// Mock the cloud-relay tunnel so POST /settings with remote_access_enabled=true
// does not attempt an outbound WebSocket connection to the real relay. The HTTP
// gate is the only enforcement layer under test here. We expose a spy on each
// function so tests can assert the route still invokes the relay side-effects
// (connect on enable, disconnect on disable) contract.
const relayConnectSpy = vi.hoisted(() => vi.fn());
const relayDisconnectSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/relay.service", () => ({
  ensureRelayConnected: (...args: unknown[]) => relayConnectSpy(...args),
  disconnectFromRelay: (...args: unknown[]) => relayDisconnectSpy(...args),
  // app.ts imports getRelayStatus at module load; provide a stable default.
  getRelayStatus: () => ({ connected: false, clients: 0, serverId: null, relayUrl: null }),
}));

// Now import everything (after mocks are hoisted)
import fs from "fs";
import { SCHEMA_SQL } from "@shared/schema";
import { createApp } from "../../src/app";
import { _clearAll as clearAuthState } from "../../src/services/remote-auth.service";
import { invalidateRemoteGateCache } from "../../src/middleware/remote-gate";
import { closeAll as closeAllWs } from "../../src/services/ws.service";
import { PREFS_PATH } from "../../src/services/settings.service";

// Headers that simulate a remote client (non-localhost IP)
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.50" };
const LOCAL_HEADERS = { "x-forwarded-for": "127.0.0.1" };

let app: ReturnType<typeof createApp>["app"];

beforeAll(() => {
  testDb.exec(SCHEMA_SQL);
  ({ app } = createApp());
});

beforeEach(() => {
  // Clean slate for each test: clear in-memory auth state + DB rows + preferences + caches
  clearAuthState();
  invalidateRemoteGateCache();
  relayConnectSpy.mockClear();
  relayDisconnectSpy.mockClear();
  testDb.exec("DELETE FROM paired_devices");
  try {
    fs.unlinkSync(PREFS_PATH);
  } catch {}
});

afterAll(() => {
  closeAllWs();
  testDb.close();
  try {
    fs.rmSync(TEST_DIR, { recursive: true });
  } catch {}
});

// ---- Helpers ----

/** Drive the toggle through the REAL POST /settings route. */
async function postSetting(key: string, value: unknown) {
  const res = await app.request("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", ...LOCAL_HEADERS },
    body: JSON.stringify({ key, value }),
  });
  expect(res.status).toBe(200);
  return res;
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
async function pairDevice(
  code: string,
  deviceName = "Test Device"
): Promise<{ token: string; device: { id: string; name: string } }> {
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

describe("POST /settings ↔ remote-gate cache invalidation", () => {
  it("rejects an already-paired device immediately after disable via POST /settings (primed cache)", async () => {
    // This is the exact regression from the bug report: a paired device that
    // just made a remote request (priming the gate cache to true) must be
    // rejected on the very next request once the user disables remote access
    // through the production POST /settings route — not up to CACHE_TTL_MS
    // (5s) later.

    // 1. Enable remote access through the REAL POST /settings route.
    await postSetting("remote_access_enabled", true);
    expect(relayConnectSpy).toHaveBeenCalledTimes(1);

    // 2. Pair a device via the public pairing flow (real Bearer token).
    const code = await generateCode();
    const { token } = await pairDevice(code);

    // 3. Prime the remote-gate cache: serve one authenticated remote request
    //    so isRemoteEnabled() caches cachedEnabled=true with a fresh TTL.
    const primed = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(primed.status).toBe(200); // cache now primed to true

    // 4. Disable remote access through the REAL POST /settings route.
    await postSetting("remote_access_enabled", false);
    expect(relayDisconnectSpy).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    expect(persisted.remote_access_enabled).toBe(false); // state is disabled

    // 5. Immediately (same tick, well inside the 5s TTL) re-issue the
    //    authenticated remote request to a protected endpoint.
    const res = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });

    // Without the fix this returned 200 (stale cached=true). Must now be 403.
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Remote access is not enabled");
  });

  it("admits a paired device immediately after enable via POST /settings (cache primed to false)", async () => {
    // Symmetric guarantee: enabling via the route invalidates the cache so a
    // remote request is admitted on the next tick — not forced to wait up to
    // CACHE_TTL_MS for the primed-false cache to lapse. Without invalidation
    // the primed cachedEnabled=false would linger for up to 5s.
    await postSetting("remote_access_enabled", true);
    const code = await generateCode();
    const { token } = await pairDevice(code);

    // Disable + issue a remote request so the gate caches cachedEnabled=false
    // with a fresh 5s TTL (the request is rejected, but isRemoteEnabled() still
    // runs and caches the fresh read).
    await postSetting("remote_access_enabled", false);
    const blocked = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(blocked.status).toBe(403); // cache now primed to false

    // Enable via the real route — must invalidate the primed-false cache.
    await postSetting("remote_access_enabled", true);
    expect(relayConnectSpy).toHaveBeenCalled();

    // Next request must be admitted immediately, not after the 5s TTL.
    const res = await app.request("/api/settings", {
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects remote requests on a cold cache (no priming) after disable via POST /settings", async () => {
    // True cold-cache path: enable then disable with NO remote requests in
    // between, so the gate cache is never populated. The next remote request
    // reads the freshly-persisted false and is rejected. This already worked
    // pre-fix; included as a regression guard so the fix doesn't break the
    // simpler cold path. Uses a public path (/api/health) so no paired token
    // is required — the gate runs before the auth middleware.
    await postSetting("remote_access_enabled", true);
    // (Intentionally do NOT make any remote request between enable and disable,
    // so the gate cache stays cold and is never primed to true.)
    await postSetting("remote_access_enabled", false);

    const res = await app.request("/api/health", { headers: REMOTE_HEADERS });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Remote access is not enabled");
  });

  it("toggling remote_access_enabled repeatedly keeps the gate in sync on each toggle", async () => {
    // Repeated toggles must each invalidate the cache — a single stale value
    // must not survive a subsequent toggle.
    await postSetting("remote_access_enabled", true);
    const code = await generateCode();
    const { token } = await pairDevice(code);

    // prime → disable → reject (403)
    expect(
      (
        await app.request("/api/settings", {
          headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(200);
    await postSetting("remote_access_enabled", false);
    expect(
      (
        await app.request("/api/settings", {
          headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(403);

    // re-enable → admit (200)
    await postSetting("remote_access_enabled", true);
    expect(
      (
        await app.request("/api/settings", {
          headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(200);

    // re-prime → re-disable → reject (403)
    await postSetting("remote_access_enabled", false);
    expect(
      (
        await app.request("/api/settings", {
          headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(403);
  });

  it("rejects remote requests even before pairing when disabled via POST /settings (primed cache)", async () => {
    // The gate runs before the auth middleware, so a disabled gate must 403
    // a remote request regardless of whether the client holds a token. Use a
    // public path so the auth layer (which would 401 a missing token) doesn't
    // mask the gate's behavior. Health is in PUBLIC_PATHS so auth skips it.

    // Enable + prime the cache to true via a public health request.
    await postSetting("remote_access_enabled", true);
    const primed = await app.request("/api/health", { headers: REMOTE_HEADERS });
    expect(primed.status).toBe(200); // gate cached true

    // Disable via the real route.
    await postSetting("remote_access_enabled", false);

    // Next remote request to the public path must be 403 from the gate.
    const res = await app.request("/api/health", { headers: REMOTE_HEADERS });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Remote access is not enabled");
  });

  it("preserves POST /settings response shape when toggling remote_access_enabled", async () => {
    const res = await postSetting("remote_access_enabled", true);
    const body = await res.json();
    expect(body).toEqual({ success: true, key: "remote_access_enabled", value: true });

    const res2 = await postSetting("remote_access_enabled", false);
    const body2 = await res2.json();
    expect(body2).toEqual({ success: true, key: "remote_access_enabled", value: false });
  });
});
