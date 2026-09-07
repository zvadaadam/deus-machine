/**
 * Regression test for the relay revokeDevice access-control bypass (CWE-862).
 *
 * Bug: a paired relay ("virtual") device could send
 *   `q:mutate { action: "revokeDevice", params: { deviceId: <victimId> } }`
 * and the routed `DELETE /api/remote-auth/devices/:id` skipped both the
 * `localhostOnly` and `authMiddleware` guards because `delegateToRoute`
 * stamps `relayBridged: true` on every in-process dispatch (commit e2c5f72d).
 * Unlike `q:request`/`q:command`, `q:mutate` did not thread `relayClient`
 * context from the connection's `isVirtual` flag, so there was no
 * ownership/self-only check downstream — `revokeDevice(id)` deletes purely
 * by `id`.
 *
 * Fix: thread caller context (`relayClient` + `deviceId`) into
 * `runMutation` the same way `getRequestContext`/`getCommandContext` do,
 * gate `revokeDevice` for relay clients to self-revoke only, and scope
 * the `pairedDevices` request to the caller's own device.
 *
 * These tests use the same SHA-256 + SQLite stack as auth-flow.test.ts and
 * drive `handleFrame` directly from a virtual `isVirtual: true` connection,
 * exactly as `relay.service.ts` does on receipt of a relay `data` frame
 * (`handleProtocolMessage(connId, msg)` → `extendedHandlers.onQueryFrame`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ---- Hoisted setup: create DB in vi.hoisted so vi.mock factories see it ----

const { testDb, TEST_DB_PATH, TEST_DIR } = vi.hoisted(() => {
  const Database = require("better-sqlite3");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  const testDir = path.join(os.tmpdir(), `deus-test-relay-revoke-${process.pid}-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const dbPath = path.join(testDir, "deus.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return { testDb: db, TEST_DB_PATH: dbPath, TEST_DIR: testDir };
});

vi.mock("../../src/lib/database", () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  closeDatabase: () => {},
  DB_PATH: TEST_DB_PATH,
}));

// server.ts is mocked because it has import-time side effects (serve()).
// That means `setApp(app)` is NOT called by the mock — we call it ourselves
// in beforeAll so `delegateToRoute` can dispatch to the Hono routes.
vi.mock("../../src/server", () => ({
  getServerPort: () => 0,
}));

import fs from "fs";
import { SCHEMA_SQL } from "@shared/schema";
import { createApp } from "../../src/app";
import { setApp } from "../../src/services/route-delegate";
import {
  addConnection,
  removeConnection,
  closeAll as closeAllWs,
  type WsSendable,
} from "../../src/services/ws.service";
import { handleFrame } from "../../src/services/query-engine";
import {
  _clearAll as clearAuthState,
  validateDeviceToken,
} from "../../src/services/remote-auth.service";
import { invalidateRemoteGateCache } from "../../src/middleware/remote-gate";
import { saveSetting, PREFS_PATH } from "../../src/services/settings.service";

// Headers that simulate local vs. remote HTTP callers (used by the pair route).
const LOCAL_HEADERS = { "x-forwarded-for": "127.0.0.1" };
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.50" };

let app: ReturnType<typeof createApp>["app"];

beforeAll(() => {
  testDb.exec(SCHEMA_SQL);
  ({ app } = createApp());
  // delegateToRoute requires the Hono app to be registered — server.ts usually
  // does this at startup, but we mocked it out, so register it here.
  setApp(app);
});

afterAll(() => {
  closeAllWs();
  testDb.close();
  try {
    fs.rmSync(TEST_DIR, { recursive: true });
  } catch {}
});

beforeEach(() => {
  // Clean slate: clear in-memory auth state, gate cache, DB rows, prefs.
  clearAuthState();
  invalidateRemoteGateCache();
  testDb.exec("DELETE FROM paired_devices");
  try {
    fs.unlinkSync(PREFS_PATH);
  } catch {}
  saveSetting("remote_access_enabled", true);
  invalidateRemoteGateCache();
});

// ---- Test helpers ----

/** Generate a pairing code as the local owner would from localhost. */
async function generateCode(): Promise<string> {
  const res = await app.request("/api/remote-auth/generate-pair-code", {
    method: "POST",
    headers: LOCAL_HEADERS,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.code;
}

/** Pair a device via the real pairing pipeline (remote IP, reusable code). */
async function pairDevice(
  code: string,
  deviceName: string
): Promise<{ token: string; device: { id: string; name: string } }> {
  const res = await app.request("/api/remote-auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HEADERS },
    body: JSON.stringify({ code, deviceName }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Minimal observable WsSendable for a relay virtual connection, mirroring the
 * shape relay.service.ts builds in `client_connected` (with a no-op `close`).
 * Captures every outbound frame in `frames` and resolves `nextFrame()` on
 * the next `send`.
 */
function createMockWs() {
  const frames: any[] = [];
  const waiters: Array<(frame: any) => void> = [];
  const ws: WsSendable = {
    send(data) {
      const parsed = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)
      );
      frames.push(parsed);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
    },
    close() {
      /* no-op — relay manages client disconnect, exactly like the real one */
    },
  };
  return {
    ws,
    frames,
    nextFrame: (): Promise<any> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for outbound WS frame")),
          5000
        );
        if (frames.length > 0) {
          clearTimeout(timeout);
          resolve(frames.shift());
        } else {
          waiters.push((frame) => {
            clearTimeout(timeout);
            resolve(frame);
          });
        }
      }),
  };
}

/** Send a `q:mutate` frame and resolve with the outbound `q:mutate_result`. */
async function sendMutate(
  connId: string,
  mock: ReturnType<typeof createMockWs>,
  id: string,
  action: string,
  params: Record<string, unknown>
): Promise<any> {
  const pending = mock.nextFrame();
  handleFrame(connId, { type: "q:mutate", id, action, params });
  return pending;
}

/** Send a `q:request` frame and resolve with the outbound `q:response`. */
async function sendRequest(
  connId: string,
  mock: ReturnType<typeof createMockWs>,
  id: string,
  resource: string,
  params?: Record<string, unknown>
): Promise<any> {
  const pending = mock.nextFrame();
  handleFrame(
    connId,
    params ? { type: "q:request", id, resource, params } : { type: "q:request", id, resource }
  );
  return pending;
}

// ============================================================================
// Tests
// ============================================================================

describe("relay virtual connection revokeDevice access control", () => {
  it("rejects cross-device revokeDevice from a relay virtual connection", async () => {
    // Pair two real devices through the full SHA-256 + SQLite pairing pipeline
    const ownerCode = await generateCode();
    const attackerCode = await generateCode();
    const { token: ownerToken, device: ownerDev } = await pairDevice(ownerCode, "Owner Phone");
    const { token: attackerToken, device: attackerDev } = await pairDevice(
      attackerCode,
      "Attacker"
    );

    // The attacker connects via the relaytunnel — relay.service.ts registers
    // a virtual WsConnection with `isVirtual: true` keyed by the attacker's
    // paired-device id. We mirror that exact registration here.
    const mock = createMockWs();
    const connId = addConnection(mock.ws, attackerDev.id, true);

    try {
      // Attacker attempts to revoke the OWNER's device via q:mutate.
      // Before the fix this returned `{ success: true }` and deleted the owner.
      const result = await sendMutate(connId, mock, "m_1", "revokeDevice", {
        deviceId: ownerDev.id,
      });

      expect(result.type).toBe("q:mutate_result");
      expect(result.id).toBe("m_1");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/own device|local owner|desktop app/i);

      // The owner's Bearer token MUST still authenticate — the revocation was
      // blocked at the dispatch tier before delegateToRoute touched the DB.
      const ownerDeviceAfter = validateDeviceToken(ownerToken);
      expect(ownerDeviceAfter).not.toBeNull();
      expect(ownerDeviceAfter!.id).toBe(ownerDev.id);

      // The attacker's own access is preserved (no self-revocation occurred).
      const attackerDeviceAfter = validateDeviceToken(attackerToken);
      expect(attackerDeviceAfter).not.toBeNull();
      expect(attackerDeviceAfter!.id).toBe(attackerDev.id);

      // And the owner row is still present in the DB.
      const ownerRow = testDb
        .prepare("SELECT id FROM paired_devices WHERE id = ?")
        .get(ownerDev.id);
      expect(ownerRow).toBeTruthy();
    } finally {
      removeConnection(connId);
    }
  });

  it("allows a relay client to self-revoke its own device", async () => {
    const code = await generateCode();
    const { token: attackerToken, device: attackerDev } = await pairDevice(code, "Attacker");

    const mock = createMockWs();
    const connId = addConnection(mock.ws, attackerDev.id, true);

    try {
      const result = await sendMutate(connId, mock, "m_self", "revokeDevice", {
        deviceId: attackerDev.id,
      });

      expect(result.type).toBe("q:mutate_result");
      expect(result.id).toBe("m_self");
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ success: true });

      // Self-revocation DID delete the row — the attacker's token no longer
      // authenticates. This is the intended "sign out this device" UX.
      expect(validateDeviceToken(attackerToken)).toBeNull();
    } finally {
      removeConnection(connId);
    }
  });

  it("does not let a relay client revoke a nonexistent device as a side-channel", async () => {
    const code = await generateCode();
    const { device: attackerDev } = await pairDevice(code, "Attacker");

    const mock = createMockWs();
    const connId = addConnection(mock.ws, attackerDev.id, true);

    try {
      const result = await sendMutate(connId, mock, "m_ghost", "revokeDevice", {
        deviceId: "ffffffffffffffffffffffffffffffff",
      });

      expect(result.type).toBe("q:mutate_result");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/own device|local owner|desktop app/i);
    } finally {
      removeConnection(connId);
    }
  });
});

describe("relay virtual connection pairedDevices request scoping", () => {
  it("scopes pairedDevices to the caller's own device for relay clients", async () => {
    const ownerCode = await generateCode();
    const attackerCode = await generateCode();
    const { device: ownerDev } = await pairDevice(ownerCode, "Owner Phone");
    const { device: attackerDev } = await pairDevice(attackerCode, "Attacker");

    const mock = createMockWs();
    const connId = addConnection(mock.ws, attackerDev.id, true);

    try {
      const result = await sendRequest(connId, mock, "r_1", "pairedDevices");

      expect(result.type).toBe("q:response");
      expect(result.id).toBe("r_1");
      expect(Array.isArray(result.data.devices)).toBe(true);
      // Only the caller's own device — never other paired devices' ids.
      expect(result.data.devices).toHaveLength(1);
      expect(result.data.devices[0].id).toBe(attackerDev.id);
      expect(result.data.devices.find((d: any) => d.id === ownerDev.id)).toBeUndefined();
      // token_hash must never be exposed (existing safety property, re-asserted here).
      expect(result.data.devices[0]).not.toHaveProperty("token_hash");
    } finally {
      removeConnection(connId);
    }
  });

  it("returns an empty pairedDevices list for a relay client whose device has no row", async () => {
    // Defensive case: a relay-client deviceId with no matching row should not
    // crash the dispatcher or leak other devices' rows.
    const mock = createMockWs();
    const connId = addConnection(mock.ws, "orphan-device-id-not-in-db", true);

    try {
      const result = await sendRequest(connId, mock, "r_orphan", "pairedDevices");

      expect(result.type).toBe("q:response");
      expect(result.data.devices).toEqual([]);
    } finally {
      removeConnection(connId);
    }
  });
});

describe("local (non-relay) connection device management regression", () => {
  it("returns all paired devices to a local desktop connection", async () => {
    const code1 = await generateCode();
    const code2 = await generateCode();
    const { device: dev1 } = await pairDevice(code1, "Phone");
    const { device: dev2 } = await pairDevice(code2, "Tablet");

    // Local desktop WS — isVirtual = false, deviceId = null (auto-auth on localhost).
    const mock = createMockWs();
    const connId = addConnection(mock.ws, null, false);

    try {
      const result = await sendRequest(connId, mock, "r_local", "pairedDevices");

      expect(result.type).toBe("q:response");
      expect(result.data.devices).toHaveLength(2);
      const ids = result.data.devices.map((d: any) => d.id);
      expect(ids).toContain(dev1.id);
      expect(ids).toContain(dev2.id);
    } finally {
      removeConnection(connId);
    }
  });

  it("allows the local owner to revoke arbitrary devices via q:mutate", async () => {
    const code = await generateCode();
    const { token: targetToken, device: targetDev } = await pairDevice(code, "Target Device");

    // Local desktop WS — relayClient = false, so the revokeDevice gate does not fire.
    const mock = createMockWs();
    const connId = addConnection(mock.ws, null, false);

    try {
      const result = await sendMutate(connId, mock, "m_local_owner", "revokeDevice", {
        deviceId: targetDev.id,
      });

      expect(result.type).toBe("q:mutate_result");
      expect(result.id).toBe("m_local_owner");
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ success: true });

      // The target device's row was actually deleted — owner retains full control.
      expect(validateDeviceToken(targetToken)).toBeNull();
    } finally {
      removeConnection(connId);
    }
  });
});
