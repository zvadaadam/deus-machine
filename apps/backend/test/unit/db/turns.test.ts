import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { getTurnsForMessages, saveTurn } from "../../../src/db/turns";

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
