/**
 * The `messages` operation: one page of a transcript.
 *
 * It used to have two producers (the socket's query and an HTTP fallback) that
 * drifted: the fallback lost `compactions`, the one field no client can notice
 * missing, because a page with no compactions and a page missing them render
 * identically. There is one producer now; these tests pin its shape.
 *
 * Runs against a real in-memory SQLite: the handler is almost entirely SQL.
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

import * as api from "@shared/api/sessions";
import { operations } from "../../helpers";
import sessionHandlers from "../../../src/api/sessions";

const run = operations(sessionHandlers);

const SESSION = "sess-rest";

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

const fetchPage = () => run(api.messages, { sessionId: SESSION });

describeWithDb("messages", () => {
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

  it("answers every field of a transcript page", async () => {
    addCompaction(db, "c1", "turn-1");

    const body = await fetchPage();

    // The `PaginatedMessages` contract, checked as a whole.
    expect(Object.keys(body).sort()).toEqual([
      "compactions",
      "has_newer",
      "has_older",
      "messages",
      "turns",
    ]);
  });

  it("pages backwards from a message seq and says whether older history remains", async () => {
    const [first, second] = (await fetchPage()).messages;

    const older = await run(api.messages, { sessionId: SESSION, before: second.seq });
    expect(older.messages.map((m) => m.id)).toEqual([first.id]);
    expect(older.has_older).toBe(false);

    const latest = await run(api.messages, { sessionId: SESSION, limit: 1 });
    expect(latest.messages.map((m) => m.id)).toEqual([second.id]);
    expect(latest.has_older).toBe(true);
  });

  it("refuses a page with no session", async () => {
    await expect(run(api.messages, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "messages requires sessionId",
    });
  });
});
