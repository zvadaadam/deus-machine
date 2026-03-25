/**
 * WebSocket integration tests for remote access auth.
 *
 * These tests spin up a real HTTP server (required by @hono/node-ws) and
 * connect with native WebSocket to verify the full WS auth flow:
 *   - Localhost connections auto-authenticate on open
 *   - Authenticated connections can subscribe/unsubscribe/pong
 *   - Malformed messages are silently ignored
 *   - Connection cleanup on disconnect
 *
 * The server starts on port 0 (OS-assigned) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { serve } from "@hono/node-server";

// ---- Hoisted setup: create DB before vi.mock factories run ----

const { testDb, TEST_DB_PATH, TEST_DIR } = vi.hoisted(() => {
  const Database = require("better-sqlite3");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  // Use a real temp directory so PREFS_PATH (derived from DB_PATH) resolves correctly.
  const testDir = path.join(os.tmpdir(), `deus-test-ws-auth-${process.pid}-${Date.now()}`);
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

vi.mock("../../src/server", () => ({
  getServerPort: () => 0,
}));

import fs from "fs";
import { SCHEMA_SQL } from "@shared/schema";
import { createApp } from "../../src/app";
import {
  _clearAll as clearAuthState,
  createDeviceToken,
} from "../../src/services/remote-auth.service";
import { invalidateRemoteGateCache } from "../../src/middleware/remote-gate";
import { closeAll as closeAllWs } from "../../src/services/ws.service";
import { saveSetting, PREFS_PATH } from "../../src/services/settings.service";

let server: ReturnType<typeof serve>;
let port: number;
let app: ReturnType<typeof createApp>["app"];

/** Enable remote access in preferences. */
function enableRemoteAccess() {
  saveSetting("remote_access_enabled", true);
  invalidateRemoteGateCache();
}

/** Create a device token directly (bypasses pairing for WS-focused tests). */
function createTestToken(): string {
  const { token } = createDeviceToken("WS Test Device", "203.0.113.50", "TestAgent/1.0");
  return token;
}

/** Connect a WebSocket. Returns the WebSocket and a promise for the first message. */
function connectWs(): { ws: WebSocket; firstMessage: Promise<any> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  const firstMessage = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS first message timeout")), 5000);
    ws.onmessage = (evt) => {
      clearTimeout(timeout);
      resolve(JSON.parse(evt.data as string));
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });

  return { ws, firstMessage };
}

/** Wait for the WebSocket to close. Returns the close code. */
function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS close timeout")), 5000);
    ws.onclose = (evt) => {
      clearTimeout(timeout);
      resolve(evt.code);
    };
  });
}

beforeAll(async () => {
  testDb.exec(SCHEMA_SQL);
  const created = createApp();
  app = created.app;

  // Start a real HTTP server on a random port
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      port = info.port;
      resolve();
    });
    created.injectWebSocket(server);
  });
});

beforeEach(() => {
  clearAuthState();
  invalidateRemoteGateCache();
  testDb.exec("DELETE FROM paired_devices");
  // Settings live in preferences.json now (settings table was removed)
  try {
    fs.unlinkSync(PREFS_PATH);
  } catch {}
  enableRemoteAccess();
});

afterAll(() => {
  closeAllWs();
  server?.close();
  testDb.close();
  // Clean up temp directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true });
  } catch {}
});

// ============================================================================
// Tests
// ============================================================================

describe("WebSocket: localhost auto-auth", () => {
  it("auto-authenticates localhost connections on open", async () => {
    const { ws, firstMessage } = connectWs();
    try {
      const msg = await firstMessage;
      expect(msg.type).toBe("connected");
      expect(msg.connectionId).toBeTruthy();
    } finally {
      ws.close();
    }
  });
});

describe("WebSocket: token validation via real hash path", () => {
  it("createDeviceToken + validateDeviceToken agree on SHA-256 hashing", async () => {
    // This verifies end-to-end: create token -> hash stored in DB -> validate by re-hashing
    const token = createTestToken();

    // Use non-public path to exercise auth middleware's token validation
    const res = await app.request("/api/settings", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);

    // Wrong token fails
    const res2 = await app.request("/api/settings", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        authorization: "Bearer wrong-token",
      },
    });
    expect(res2.status).toBe(401);
  });
});

describe("WebSocket: protocol messages", () => {
  it("handles subscribe and pong messages", async () => {
    const { ws, firstMessage } = connectWs();
    try {
      const connected = await firstMessage;
      expect(connected.type).toBe("connected");

      // Send subscribe -- fire-and-forget, no response expected
      ws.send(JSON.stringify({ type: "subscribe", topics: ["session:abc"] }));

      // Send pong -- response to server's heartbeat ping
      ws.send(JSON.stringify({ type: "pong" }));

      // Send unsubscribe
      ws.send(JSON.stringify({ type: "unsubscribe", topics: ["session:abc"] }));

      // Connection stays alive after all protocol messages
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });

  it("ignores malformed JSON messages without closing", async () => {
    const { ws, firstMessage } = connectWs();
    try {
      await firstMessage;
      // Send garbage -- should be silently ignored
      ws.send("not json at all");
      ws.send("{broken json");

      // Let server process the messages
      await new Promise((r) => setTimeout(r, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});

describe("WebSocket: connection lifecycle", () => {
  it("cleans up on client disconnect", async () => {
    const { ws, firstMessage } = connectWs();
    const connected = await firstMessage;
    expect(connected.connectionId).toBeTruthy();

    // Close from client side
    ws.close();

    // Wait for close to propagate
    const closeCode = await waitForClose(ws);
    // Normal close code (1000 or 1005 for no-status)
    expect([1000, 1005]).toContain(closeCode);
  });
});
