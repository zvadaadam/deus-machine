/**
 * GET /sessions/:id/messages — the HTTP fallback for the WS `messages` query.
 *
 * Two producers answer the same resource: `runQuery("messages")` over the
 * socket, and this route for clients that cannot hold one. "Same resource" has
 * to mean the same SHAPE — and the field that went missing here is the one no
 * client can notice, because a page with no compactions and a page missing its
 * compactions render identically.
 *
 * Runs against a real in-memory SQLite: the route is almost entirely SQL.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const { mockGetDatabase } = vi.hoisted(() => ({ mockGetDatabase: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));

import app from "../../../src/routes/sessions";

const SESSION = "sess-rest";

interface MessagePage {
  messages: Array<{ id: string }>;
  compactions: Array<{ compaction_id: string; turn_id: string }>;
  has_older: boolean;
  has_newer: boolean;
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO repositories (id, name, root_path) VALUES ('r1', 'repo', '/tmp/repo')`
  ).run();
  db.prepare(`INSERT INTO workspaces (id, repository_id, slug) VALUES ('w1', 'r1', 'ws')`).run();
  db.prepare(`INSERT INTO sessions (id, workspace_id) VALUES (?, 'w1')`).run(SESSION);
  for (const [id, turn] of [
    ["m1", "turn-1"],
    ["m2", "turn-2"],
  ]) {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, turn_id, sent_at)
       VALUES (?, ?, 'assistant', ?, datetime('now'))`
    ).run(id, SESSION, turn);
  }
  return db;
}

function addCompaction(db: Database.Database, id: string, turnId: string): void {
  db.prepare(
    `INSERT INTO compactions (compaction_id, session_id, turn_id, status, pre_tokens, post_tokens)
     VALUES (?, ?, ?, 'completed', 100000, 20000)`
  ).run(id, SESSION, turnId);
}

const fetchPage = async (): Promise<MessagePage> => {
  const res = await app.request(`/sessions/${SESSION}/messages`);
  expect(res.status).toBe(200);
  return (await res.json()) as MessagePage;
};

describeWithDb("GET /sessions/:id/messages", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    mockGetDatabase.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("returns the session's compaction markers alongside its messages", async () => {
    addCompaction(db, "c1", "turn-1");
    addCompaction(db, "c2", "turn-2");

    const body = await fetchPage();

    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    // Without these the transcript loses every "context compacted" divider,
    // and nothing about the response says so.
    expect(body.compactions.map((c) => c.compaction_id)).toEqual(["c1", "c2"]);
    expect(body.compactions[0]).toMatchObject({ turn_id: "turn-1", status: "completed" });
  });

  it("answers an empty list, not a missing field, when nothing has compacted", async () => {
    const body = await fetchPage();

    expect(body).toHaveProperty("compactions");
    expect(body.compactions).toEqual([]);
  });

  it("answers every field of the `messages` resource the WS query answers", async () => {
    addCompaction(db, "c1", "turn-1");

    const body = await fetchPage();

    // The `PaginatedMessages` contract, checked as a whole: while `compactions`
    // was the one OPTIONAL field, this route could omit it and both the types
    // and the UI agreed.
    expect(Object.keys(body).sort()).toEqual(["compactions", "has_newer", "has_older", "messages"]);
  });
});
