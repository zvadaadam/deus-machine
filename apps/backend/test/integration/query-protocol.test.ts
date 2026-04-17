/**
 * Query protocol integration tests.
 *
 * Spins up a real HTTP server + SQLite DB + WebSocket, then exercises every
 * q:* frame type end-to-end:
 *   - q:request → q:response (one-shot queries for all 4 resources)
 *   - q:subscribe → q:snapshot (initial + live push on invalidation)
 *   - q:subscribe → q:delta (cursor-based message deltas)
 *   - q:unsubscribe (stops receiving pushes)
 *   - q:mutate → q:mutate_result (archiveWorkspace, updateWorkspaceTitle, sendMessage)
 *   - Error handling (unknown frames, missing params, connection cleanup)
 *
 * Pattern follows ws-auth.test.ts: real DB created in vi.hoisted(), real
 * server on port 0, native WebSocket clients.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { serve } from "@hono/node-server";

// ---- Hoisted setup: create DB before vi.mock factories run ----

const { testDb, TEST_DB_PATH, TEST_DIR } = vi.hoisted(() => {
  const Database = require("better-sqlite3");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  const testDir = path.join(os.tmpdir(), `deus-test-query-${process.pid}-${Date.now()}`);
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
import { closeAll as closeAllWs } from "../../src/services/ws.service";
import { resetStatsCache } from "../../src/db";
import { invalidate } from "../../src/services/query-engine";

// ---- Constants ----

const REPO_ID = "repo-q-001";
const WS_ID = "ws-q-001";
const SESS_ID = "sess-q-001";

// ---- Server state ----

let server: ReturnType<typeof serve>;
let port: number;

// ---- Seed helpers ----

function seedTestData() {
  testDb
    .prepare(
      `
    INSERT INTO repositories (id, name, root_path, git_default_branch)
    VALUES (?, 'test-repo', '/tmp/test-repo', 'main')
  `
    )
    .run(REPO_ID);

  testDb
    .prepare(
      `
    INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id)
    VALUES (?, ?, 'tokyo', 'Tokyo workspace', 'ready', ?)
  `
    )
    .run(WS_ID, REPO_ID, SESS_ID);

  testDb
    .prepare(
      `
    INSERT INTO sessions (id, workspace_id, agent_harness, status)
    VALUES (?, ?, 'claude', 'idle')
  `
    )
    .run(SESS_ID, WS_ID);

  seedMessages();
}

function seedMessages() {
  const msgs = [
    { id: "msg-q-001", role: "user", content: "hello" },
    { id: "msg-q-002", role: "assistant", content: "world" },
    { id: "msg-q-003", role: "user", content: "!" },
  ];
  for (const m of msgs) {
    testDb
      .prepare(
        `
      INSERT INTO messages (id, session_id, role, content, sent_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `
      )
      .run(m.id, SESS_ID, m.role, m.content);
  }
}

// ---- WS helpers ----

/** Connect and wait for the "connected" frame. Returns ws + connectionId. */
async function connectAndAuth(): Promise<{ ws: WebSocket; connectionId: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  const connectionId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    ws.onmessage = (evt) => {
      clearTimeout(timeout);
      const msg = JSON.parse(evt.data as string);
      if (msg.type === "connected") resolve(msg.connectionId);
      else reject(new Error(`Expected connected, got ${msg.type}`));
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });

  return { ws, connectionId };
}

/**
 * Send a q:* frame and wait for the next message matching the expected type.
 * Skips intermediate messages (e.g., legacy broadcasts) that don't match.
 */
function sendAndReceive(
  ws: WebSocket,
  frame: object,
  expectType: string,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for ${expectType}`)),
      timeoutMs
    );
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === expectType) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
      // else: skip non-matching messages (legacy broadcasts, etc.)
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(frame));
  });
}

/**
 * Wait for the next message of a given type without sending anything.
 * Used after invalidate() to catch pushed snapshots/deltas.
 */
function waitForMessage(ws: WebSocket, expectType: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for ${expectType}`)),
      timeoutMs
    );
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === expectType) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/**
 * Collect all messages within a time window. Resolves with the array.
 * Used to assert that NO messages are received (expect empty array).
 */
function collectMessages(ws: WebSocket, timeoutMs = 300): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const handler = (evt: MessageEvent) => {
      messages.push(JSON.parse(evt.data as string));
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, timeoutMs);
  });
}

// ---- Lifecycle ----

beforeAll(async () => {
  testDb.exec(SCHEMA_SQL);
  seedTestData();

  const created = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      port = info.port;
      resolve();
    });
    created.injectWebSocket(server);
  });
});

beforeEach(() => {
  resetStatsCache();

  // Reset messages to clean state for each test
  testDb.exec("DELETE FROM messages");
  seedMessages();

  // Reset workspace and session state (mutations may have changed them)
  testDb
    .prepare("UPDATE workspaces SET state = 'ready', title = 'Tokyo workspace' WHERE id = ?")
    .run(WS_ID);
  testDb
    .prepare("UPDATE sessions SET status = 'idle', last_user_message_at = NULL WHERE id = ?")
    .run(SESS_ID);
});

afterAll(() => {
  closeAllWs();
  server?.close();
  testDb.close();
  try {
    fs.rmSync(TEST_DIR, { recursive: true });
  } catch {}
});

// ============================================================================
// Tests
// ============================================================================

describe("q:request → q:response", () => {
  it("fetches workspaces as RepoGroup[]", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-1",
          resource: "workspaces",
        },
        "q:response"
      );

      expect(res.id).toBe("req-1");
      expect(Array.isArray(res.data)).toBe(true);
      // Data is now RepoGroup[] — find workspace inside groups
      const group = res.data.find((g: any) => g.repo_id === REPO_ID);
      expect(group).toBeTruthy();
      expect(group.repo_name).toBe("test-repo");
      const found = group.workspaces.find((w: any) => w.id === WS_ID);
      expect(found).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it("fetches stats", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-2",
          resource: "stats",
        },
        "q:response"
      );

      expect(res.id).toBe("req-2");
      expect(res.data.workspaces).toBeGreaterThanOrEqual(1);
    } finally {
      ws.close();
    }
  });

  it("fetches sessions by workspaceId", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-3",
          resource: "sessions",
          params: { workspaceId: WS_ID },
        },
        "q:response"
      );

      expect(res.id).toBe("req-3");
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.some((s: any) => s.id === SESS_ID)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("fetches a single session by sessionId", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-session",
          resource: "session",
          params: { sessionId: SESS_ID },
        },
        "q:response"
      );

      expect(res.id).toBe("req-session");
      expect(res.data).toBeTruthy();
      expect(res.data.id).toBe(SESS_ID);
      expect(res.data.status).toBe("idle");
    } finally {
      ws.close();
    }
  });

  it("returns q:error for session without sessionId", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-session-missing",
          resource: "session",
        },
        "q:error"
      );

      expect(res.id).toBe("req-session-missing");
      expect(res.code).toBe("QUERY_ERROR");
    } finally {
      ws.close();
    }
  });

  it("fetches messages by sessionId", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-4",
          resource: "messages",
          params: { sessionId: SESS_ID },
        },
        "q:response"
      );

      expect(res.id).toBe("req-4");
      expect(res.data.messages).toHaveLength(3);
      expect(res.data.has_older).toBe(false);
      expect(res.data.has_newer).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("returns q:error for unknown resource", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-err",
          resource: "nonexistent",
        },
        "q:error"
      );

      expect(res.id).toBe("req-err");
      expect(res.code).toBe("QUERY_ERROR");
    } finally {
      ws.close();
    }
  });

  it("returns q:error for sessions without workspaceId", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:request",
          id: "req-missing",
          resource: "sessions",
        },
        "q:error"
      );

      expect(res.id).toBe("req-missing");
      expect(res.code).toBe("QUERY_ERROR");
    } finally {
      ws.close();
    }
  });
});

describe("q:subscribe → initial q:snapshot", () => {
  it("returns snapshot with subscription ID for workspaces (RepoGroup[])", async () => {
    const { ws } = await connectAndAuth();
    try {
      const snap = await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_ws_1",
          resource: "workspaces",
        },
        "q:snapshot"
      );

      expect(snap.id).toBe("sub_ws_1");
      expect(Array.isArray(snap.data)).toBe(true);
      // Data is now RepoGroup[] — find workspace inside groups
      const group = snap.data.find((g: any) => g.repo_id === REPO_ID);
      expect(group).toBeTruthy();
      expect(group.workspaces.some((w: any) => w.id === WS_ID)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("sends null snapshot for messages (delta-only subscription)", async () => {
    const { ws } = await connectAndAuth();
    try {
      const snap = await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_msg_1",
          resource: "messages",
          params: { sessionId: SESS_ID },
        },
        "q:snapshot"
      );

      expect(snap.id).toBe("sub_msg_1");
      // Messages subscription is delta-only: sends null snapshot as ack.
      // The HTTP queryFn loads the full set; WS only pushes deltas.
      expect(snap.data).toBeNull();
    } finally {
      ws.close();
    }
  });
});

describe("q:subscribe → live q:snapshot push", () => {
  it("pushes updated snapshot when invalidate() is called", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe and receive initial snapshot (RepoGroup[])
      const initial = await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_live_1",
          resource: "workspaces",
        },
        "q:snapshot"
      );
      const initialGroup = initial.data.find((g: any) => g.repo_id === REPO_ID);
      const initialWsCount = initialGroup.workspaces.length;

      // Insert a new workspace
      testDb
        .prepare(
          `
        INSERT INTO workspaces (id, repository_id, slug, state)
        VALUES ('ws-q-new', ?, 'osaka', 'ready')
      `
        )
        .run(REPO_ID);

      try {
        // Trigger invalidation and wait for pushed snapshot
        const pushPromise = waitForMessage(ws, "q:snapshot");
        invalidate(["workspaces"]);
        const pushed = await pushPromise;

        expect(pushed.id).toBe("sub_live_1");
        const pushedGroup = pushed.data.find((g: any) => g.repo_id === REPO_ID);
        expect(pushedGroup.workspaces.length).toBe(initialWsCount + 1);
      } finally {
        testDb.prepare("DELETE FROM workspaces WHERE id = 'ws-q-new'").run();
      }
    } finally {
      ws.close();
    }
  });

  it("only pushes for subscribed resources", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe to stats only
      await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_stats_only",
          resource: "stats",
        },
        "q:snapshot"
      );

      // Invalidate workspaces (not stats) — should NOT push to this subscriber
      invalidate(["workspaces"]);

      // Collect messages for a short window — expect nothing
      const msgs = await collectMessages(ws, 200);
      const snapshots = msgs.filter((m) => m.type === "q:snapshot");
      expect(snapshots).toHaveLength(0);
    } finally {
      ws.close();
    }
  });
});

describe("q:subscribe → q:delta for messages", () => {
  it("pushes delta with new messages after invalidation", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe to messages
      await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_delta_1",
          resource: "messages",
          params: { sessionId: SESS_ID },
        },
        "q:snapshot"
      );

      // Insert a new message directly
      testDb
        .prepare(
          `
        INSERT INTO messages (id, session_id, role, content, sent_at)
        VALUES ('msg-q-new-1', ?, 'user', 'delta test', datetime('now'))
      `
        )
        .run(SESS_ID);

      // Trigger invalidation and wait for delta
      const deltaPromise = waitForMessage(ws, "q:delta");
      invalidate(["messages"]);
      const delta = await deltaPromise;

      expect(delta.id).toBe("sub_delta_1");
      expect(delta.upserted).toHaveLength(1);
      expect(delta.upserted[0].content).toBe("delta test");
      expect(delta.cursor).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  it("advances cursor correctly across multiple deltas", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe
      await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_cursor",
          resource: "messages",
          params: { sessionId: SESS_ID },
        },
        "q:snapshot"
      );

      // First delta
      testDb
        .prepare(
          `
        INSERT INTO messages (id, session_id, role, content, sent_at)
        VALUES ('msg-q-cur-1', ?, 'user', 'first new', datetime('now'))
      `
        )
        .run(SESS_ID);
      const delta1Promise = waitForMessage(ws, "q:delta");
      invalidate(["messages"]);
      const delta1 = await delta1Promise;
      expect(delta1.upserted).toHaveLength(1);
      const cursor1 = delta1.cursor;

      // Second delta — should only contain the newest message
      testDb
        .prepare(
          `
        INSERT INTO messages (id, session_id, role, content, sent_at)
        VALUES ('msg-q-cur-2', ?, 'assistant', 'second new', datetime('now'))
      `
        )
        .run(SESS_ID);
      const delta2Promise = waitForMessage(ws, "q:delta");
      invalidate(["messages"]);
      const delta2 = await delta2Promise;

      expect(delta2.upserted).toHaveLength(1);
      expect(delta2.upserted[0].content).toBe("second new");
      expect(delta2.cursor).toBeGreaterThan(cursor1);
    } finally {
      ws.close();
    }
  });
});

describe("q:unsubscribe", () => {
  it("stops receiving pushes after unsubscribe", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe
      await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_unsub_1",
          resource: "workspaces",
        },
        "q:snapshot"
      );

      // Unsubscribe
      ws.send(JSON.stringify({ type: "q:unsubscribe", id: "sub_unsub_1" }));

      // Small delay for unsubscribe to process
      await new Promise((r) => setTimeout(r, 50));

      // Invalidate — should NOT push
      invalidate(["workspaces"]);

      // Collect messages — expect no snapshots
      const msgs = await collectMessages(ws, 300);
      const snapshots = msgs.filter((m) => m.type === "q:snapshot");
      expect(snapshots).toHaveLength(0);
    } finally {
      ws.close();
    }
  });
});

describe("q:mutate → q:mutate_result", () => {
  it("archives a workspace", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:mutate",
          id: "mut-1",
          action: "archiveWorkspace",
          params: { workspaceId: WS_ID },
        },
        "q:mutate_result"
      );

      expect(res.id).toBe("mut-1");
      expect(res.success).toBe(true);

      // Verify in DB
      const row = testDb.prepare("SELECT state FROM workspaces WHERE id = ?").get(WS_ID) as any;
      expect(row.state).toBe("archived");
    } finally {
      ws.close();
    }
  });

  it("updates workspace title", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:mutate",
          id: "mut-2",
          action: "updateWorkspaceTitle",
          params: { workspaceId: WS_ID, title: "New Title" },
        },
        "q:mutate_result"
      );

      expect(res.id).toBe("mut-2");
      expect(res.success).toBe(true);

      // Verify in DB
      const row = testDb.prepare("SELECT title FROM workspaces WHERE id = ?").get(WS_ID) as any;
      expect(row.title).toBe("New Title");
    } finally {
      ws.close();
    }
  });

  it("returns error for unknown mutation", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:mutate",
          id: "mut-err",
          action: "deleteEverything",
          params: {},
        },
        "q:mutate_result"
      );

      expect(res.id).toBe("mut-err");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Unknown mutation");
    } finally {
      ws.close();
    }
  });
});

describe("q:command → q:command_ack", () => {
  it("sends a message via q:command and returns command_ack", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:command",
          id: "cmd-1",
          command: "sendMessage",
          params: {
            sessionId: SESS_ID,
            content: "command test",
            model: "sonnet",
            agentHarness: "claude",
          },
        },
        "q:command_ack"
      );

      expect(res.id).toBe("cmd-1");
      expect(res.accepted).toBe(true);
      expect(res.commandId).toEqual(expect.any(String));

      // Verify message was persisted
      const messageRow = testDb
        .prepare("SELECT session_id, role, content, model FROM messages WHERE id = ?")
        .get(res.commandId) as
        | { session_id: string; role: string; content: string; model: string }
        | undefined;
      expect(messageRow).toEqual({
        session_id: SESS_ID,
        role: "user",
        content: "command test",
        model: "sonnet",
      });

      // Verify session status — without a running agent server, the session
      // transitions to "error" because handleSendMessage persists an error
      // when the agent transport is disconnected (prevents silent stalls).
      const sessionRow = testDb
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(SESS_ID) as { status: string };
      expect(sessionRow.status).toBe("error");
    } finally {
      ws.close();
    }
  });

  it("stops a session via q:command", async () => {
    const { ws } = await connectAndAuth();
    try {
      // First set session to working
      testDb.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(SESS_ID);

      const res = await sendAndReceive(
        ws,
        {
          type: "q:command",
          id: "cmd-stop-1",
          command: "stopSession",
          params: { sessionId: SESS_ID },
        },
        "q:command_ack"
      );

      expect(res.id).toBe("cmd-stop-1");
      expect(res.accepted).toBe(true);

      // Verify session status changed to idle
      const sessionRow = testDb
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(SESS_ID) as { status: string };
      expect(sessionRow.status).toBe("idle");
    } finally {
      ws.close();
    }
  });

  it("returns rejected ack for unknown command", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:command",
          id: "cmd-err",
          command: "destroyEverything",
          params: {},
        },
        "q:command_ack"
      );

      expect(res.id).toBe("cmd-err");
      expect(res.accepted).toBe(false);
      expect(res.error).toContain("Unknown command");
    } finally {
      ws.close();
    }
  });

  it("pushes workspace delta after sendMessage command", async () => {
    const { ws } = await connectAndAuth();
    try {
      // Subscribe to workspaces
      await sendAndReceive(
        ws,
        {
          type: "q:subscribe",
          id: "sub_ws_delta",
          resource: "workspaces",
        },
        "q:snapshot"
      );

      // Send message via q:command — triggers invalidation with sessionId context
      const deltaPromise = waitForMessage(ws, "q:delta");
      ws.send(
        JSON.stringify({
          type: "q:command",
          id: "cmd-delta-1",
          command: "sendMessage",
          params: {
            sessionId: SESS_ID,
            content: "delta check",
            model: "claude-sonnet-4-6",
            agentHarness: "claude",
          },
        })
      );

      // Wait for both the command ack and the delta push
      const [ack, delta] = await Promise.all([waitForMessage(ws, "q:command_ack"), deltaPromise]);

      expect(ack.accepted).toBe(true);
      expect(delta.id).toBe("sub_ws_delta");
      expect(delta.upserted).toHaveLength(1);
      expect(delta.upserted[0].id).toBe(WS_ID);
      expect(delta.upserted[0].session_status).toBe("working");
    } finally {
      ws.close();
    }
  });
});

describe("Error handling", () => {
  it("returns q:error for unknown q:* frame type", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:bogus",
          id: "err-1",
        },
        "q:error"
      );

      expect(res.id).toBe("err-1");
      expect(res.code).toBe("UNKNOWN_FRAME");
    } finally {
      ws.close();
    }
  });

  it("returns q:error for malformed q:* frames", async () => {
    const { ws } = await connectAndAuth();
    try {
      const res = await sendAndReceive(
        ws,
        {
          type: "q:mutate",
          id: 123,
          action: "sendMessage",
          params: { sessionId: SESS_ID, content: "bad" },
        },
        "q:error"
      );

      expect(res.id).toBe("unknown");
      expect(res.code).toBe("INVALID_FRAME");
      expect(res.message).toContain("Frame requires string id");
    } finally {
      ws.close();
    }
  });

  it("handles invalidation after client disconnect without crashing", async () => {
    const { ws } = await connectAndAuth();

    await sendAndReceive(
      ws,
      {
        type: "q:subscribe",
        id: "sub_cleanup",
        resource: "workspaces",
      },
      "q:snapshot"
    );

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(() => invalidate(["workspaces"])).not.toThrow();
  });
});
