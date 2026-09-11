import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { getTurn, getTurnsForMessages, saveTurn } from "../../../src/db/turns";
import { migrateMessageTurns } from "../../../src/db/migrate-turns";

let db: Database.Database;
const start = Date.parse("2026-09-11T10:00:00Z");
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/tmp/repo');
    INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'workspace');
    INSERT INTO sessions (id, workspace_id) VALUES ('s', 'w'), ('other', 'w');
  `);
});
afterEach(() => db.close());

function legacySchema() {
  db.exec(`
    ALTER TABLE messages ADD COLUMN cancelled_at TEXT;
    ALTER TABLE messages ADD COLUMN tokens TEXT;
    ALTER TABLE messages ADD COLUMN cost REAL;
    ALTER TABLE messages ADD COLUMN turn_stop_reason TEXT;
  `);
}

describe("turn history migration", () => {
  it("preserves transcript content, empty outcomes, unknown usage, zero and cache counts", () => {
    legacySchema(); // Existing releases did not yet have turn_attribution.
    db.exec(`
      INSERT INTO messages (id, session_id, role, turn_id, sent_at)
      VALUES ('user', 's', 'user', 'one', '2026-09-11T10:00:00Z');
      INSERT INTO messages (id, session_id, role, turn_id, cancelled_at, tokens, cost, turn_stop_reason)
      VALUES ('answer', 's', 'assistant', 'one', '2026-09-11T10:00:08Z',
        '{"input":0,"output":2,"cache":{"read":10,"write":3,"writeEphemeral5m":1,"writeEphemeral1h":2}}', 0, 'cancelled');
      INSERT INTO parts (id, session_id, message_id, seq, type, data)
      VALUES ('text', 's', 'answer', 0, 'text', '{"text":"Preserve this answer"}');
      INSERT INTO messages (id, session_id, role, turn_id, sent_at, turn_stop_reason)
      VALUES ('cancelled-two', 's', 'assistant', 'two', '2026-09-11T10:00:10Z', 'error');
    `);
    const parts = db.prepare("SELECT * FROM parts").all();
    migrateMessageTurns(db);
    expect(getTurn(db, "s", "one")).toEqual({
      turnId: "one",
      startedAt: start,
      endedAt: start + 8000,
      stopReason: "cancelled",
      cost: 0,
      tokens: {
        input: 0,
        output: 2,
        cache: { read: 10, write: 3, writeEphemeral5m: 1, writeEphemeral1h: 2 },
      },
    });
    expect(getTurn(db, "s", "two")).toEqual({
      turnId: "two",
      endedAt: start + 10000,
      stopReason: "error",
    });
    expect(db.prepare("SELECT id FROM messages ORDER BY seq").all()).toEqual([
      { id: "user" },
      { id: "answer" },
    ]);
    expect(db.prepare("SELECT message_count FROM sessions WHERE id='s'").get()).toEqual({
      message_count: 2,
    });
    expect(db.prepare("SELECT * FROM parts").all()).toEqual(parts);
    migrateMessageTurns(db);
    expect(db.prepare("SELECT COUNT(*) AS n, SUM(cost) AS cost FROM turns").get()).toEqual({
      n: 2,
      cost: 0,
    });
  });

  it("rolls back the entire move when old accounting cannot be decoded", () => {
    legacySchema();
    db.exec(`INSERT INTO messages (id,session_id,role,turn_id,tokens,cost)
      VALUES ('good','s','assistant','one','{"input":2,"output":3}',1), ('bad','s','assistant','two','broken',2)`);
    expect(() => migrateMessageTurns(db)).toThrow();
    expect(db.prepare("SELECT id, cost FROM messages ORDER BY seq").all()).toEqual([
      { id: "good", cost: 1 },
      { id: "bad", cost: 2 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 0 });
    db.exec(`UPDATE messages SET tokens = '{"input":4,"output":5}' WHERE id='bad'`);
    migrateMessageTurns(db);
    expect(db.prepare("SELECT COUNT(*) AS n, SUM(cost) AS cost FROM turns").get()).toEqual({
      n: 2,
      cost: 3,
    });
  });
});

it("returns turns for a message page without creating outcomes for paginated-away messages", () => {
  for (const [index, turnId] of ["older", "current", "empty"].entries()) {
    saveTurn(db, "s", {
      turnId,
      startedAt: start + index,
      endedAt: start + index + 1,
      stopReason: "end_turn",
    });
  }
  saveTurn(db, "other", { turnId: "other", stopReason: "error" });
  db.exec(`INSERT INTO messages (id,session_id,role,turn_id)
    VALUES ('old','s','assistant','older'), ('new','s','user','current')`);
  expect(getTurnsForMessages(db, "s", [{ turn_id: "current" }]).map((turn) => turn.turnId)).toEqual(
    ["current", "empty"]
  );
  expect(getTurnsForMessages(db, "s", [{ turn_id: "older" }]).map((turn) => turn.turnId)).toEqual([
    "older",
    "empty",
  ]);
  expect(getTurnsForMessages(db, "s", []).map((turn) => turn.turnId)).toEqual(["empty"]);
  db.exec("DELETE FROM sessions WHERE id='s'");
  expect(db.prepare("SELECT turn_id FROM turns").all()).toEqual([{ turn_id: "other" }]);
});
