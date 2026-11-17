/**
 * The backend's SQLite answers the same on both engines it runs on: Node with
 * better-sqlite3 (every other backend test, `bun run dev`) and Bun with
 * bun:sqlite behind the shim in src/lib/sqlite.ts (the packaged app's
 * deus-runtime executable). This one file runs under both runners:
 *
 *   bun run test:backend        vitest on Node → better-sqlite3
 *   bun run test:bun            bun test       → bun:sqlite
 *
 * `bun test` maps imports from "vitest" to its own runner, so the file needs
 * no second entry. It opens databases only through `openSqliteDatabase` and
 * applies the real schema. Only what the backend uses is held equal here;
 * src/lib/sqlite.ts says what the shim changes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";
import { openSqliteDatabase } from "../../../src/lib/sqlite";

const engine = process.versions.bun ? "bun:sqlite" : "better-sqlite3";

let tempDir: string;
let db: BetterSqlite3.Database;

function seedSession(database: BetterSqlite3.Database, sessionId: string): void {
  database.prepare("INSERT INTO repositories (id, name) VALUES (?, ?)").run("repo-1", "Repo");
  database
    .prepare("INSERT INTO workspaces (id, repository_id, slug) VALUES (?, ?, ?)")
    .run("ws-1", "repo-1", "ws");
  database.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run(sessionId, "ws-1");
}

describe(`SQLite through openSqliteDatabase (${engine})`, () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "deus-sqlite-parity-"));
    db = openSqliteDatabase(path.join(tempDir, "deus.db"));
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("answers get with undefined when there is no row, and the row when there is", () => {
    seedSession(db, "session-1");
    const exists = db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?");
    expect(exists.get("missing")).toBeUndefined();
    expect(exists.get("session-1")).toEqual({ found: 1 });
  });

  it("answers all with every row, and an empty array for none", () => {
    seedSession(db, "session-1");
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-1" }]);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").all("missing")).toEqual([]);
  });

  it("answers run with changes and lastInsertRowid as numbers", () => {
    seedSession(db, "session-1");
    const result = db
      .prepare("UPDATE sessions SET title = ? WHERE workspace_id = ?")
      .run("Title", "ws-1");
    expect(result).toEqual({ changes: 1, lastInsertRowid: expect.any(Number) });
    expect(db.prepare("DELETE FROM sessions WHERE id = ?").run("missing").changes).toBe(0);
  });

  it("binds named parameters given without their prefix", () => {
    db.prepare("INSERT INTO repositories (id, name) VALUES (@id, @name)").run({
      id: "repo-named",
      name: "Named",
      unused: "extra keys are ignored",
    });
    expect(db.prepare("SELECT id, name FROM repositories").get()).toEqual({
      id: "repo-named",
      name: "Named",
    });
  });

  it("refuses a named parameter that is missing, rather than binding NULL", () => {
    // root_path takes NULL, so only the binding itself can refuse it.
    const insert = db.prepare(
      "INSERT INTO repositories (id, name, root_path) VALUES (@id, @name, @root_path)"
    );
    expect(() => insert.run({ id: "repo-missing", name: "Missing" })).toThrow(/root_path/);
    expect(db.prepare("SELECT count(*) AS count FROM repositories").get()).toEqual({ count: 0 });
  });

  it("binds undefined as NULL, and refuses too few positional parameters", () => {
    db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, ?, ?)").run(
      "repo-1",
      "Repo",
      undefined
    );
    expect(db.prepare("SELECT root_path FROM repositories").get()).toEqual({ root_path: null });
    expect(() =>
      db.prepare("INSERT INTO repositories (id, name) VALUES (?, ?)").run("repo-2")
    ).toThrow();
  });

  it("reads integers beyond 2^53 as imprecise numbers, and binds bigints", () => {
    const row = db
      .prepare("SELECT ? AS big, 9007199254740993 AS literal")
      .get(9007199254740993n) as { big: unknown; literal: unknown };
    expect(row).toEqual({ big: 9007199254740992, literal: 9007199254740992 });
  });

  it("reads a BLOB's bytes back (a Buffer on Node, a Uint8Array on Bun)", () => {
    const row = db.prepare("SELECT ? AS bytes").get(Buffer.from([1, 2, 3])) as {
      bytes: Uint8Array;
    };
    expect([...Buffer.from(row.bytes)]).toEqual([1, 2, 3]);
    const rows = db.prepare("SELECT ? AS bytes").all(Buffer.from([4])) as Array<{
      bytes: Uint8Array;
    }>;
    expect([...Buffer.from(rows[0].bytes)]).toEqual([4]);
  });

  it("returns a transaction's value, passes its arguments and commits it", () => {
    const insert = db.transaction((id: string, name: string) => {
      db.prepare("INSERT INTO repositories (id, name) VALUES (?, ?)").run(id, name);
      return `${id}:${name}`;
    });
    expect(insert("repo-1", "Repo")).toBe("repo-1:Repo");
    expect(db.prepare("SELECT count(*) AS count FROM repositories").get()).toEqual({ count: 1 });
  });

  it("rolls a transaction back when it throws, and a nested one alone", () => {
    const insert = (id: string) =>
      db.prepare("INSERT INTO repositories (id, name) VALUES (?, ?)").run(id, id);
    expect(() =>
      db.transaction(() => {
        insert("repo-rolled-back");
        throw new Error("boom");
      })()
    ).toThrow("boom");

    db.transaction(() => {
      insert("repo-outer");
      expect(db.inTransaction).toBe(true);
      try {
        db.transaction(() => {
          insert("repo-inner");
          throw new Error("inner");
        })();
      } catch {
        // The savepoint is rolled back; the outer transaction goes on.
      }
    })();
    expect(db.inTransaction).toBe(false);
    expect(db.prepare("SELECT id FROM repositories ORDER BY id").all()).toEqual([
      { id: "repo-outer" },
    ]);
  });

  it("answers the pragmas the backend sends as rows", () => {
    expect(db.pragma("journal_mode = WAL")).toEqual([{ journal_mode: "wal" }]);
    db.pragma("foreign_keys = ON");
    expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(db.pragma("busy_timeout = 5000")).toEqual([{ timeout: 5000 }]);
    expect(db.pragma("optimize")).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const columns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("workspace_id");
  });

  it("enforces foreign keys once they are on", () => {
    db.pragma("foreign_keys = ON");
    expect(() =>
      db
        .prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
        .run("orphan", "no-such-workspace")
    ).toThrow(/FOREIGN KEY/);
  });

  it("reports a constraint failure with SQLite's code", () => {
    seedSession(db, "session-1");
    let failure: unknown;
    try {
      db.prepare("INSERT INTO repositories (id, name) VALUES (?, ?)").run("repo-1", "Again");
    } catch (error) {
      failure = error;
    }
    expect((failure as { code?: string }).code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  });

  it("opens a database read-only, refusing writes, and refuses a missing file", () => {
    seedSession(db, "session-1");
    const readonly = openSqliteDatabase(path.join(tempDir, "deus.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(readonly.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-1" }]);
      expect(() => readonly.prepare("DELETE FROM sessions").run()).toThrow();
    } finally {
      readonly.close();
    }
    expect(() =>
      openSqliteDatabase(path.join(tempDir, "absent.db"), { readonly: true, fileMustExist: true })
    ).toThrow();
  });

  it("refuses statements once closed", () => {
    const other = openSqliteDatabase(path.join(tempDir, "other.db"));
    other.close();
    expect(() => other.prepare("SELECT 1").get()).toThrow();
  });
});

describe(`the backend's database (${engine})`, () => {
  let backendDir: string;
  let closeDatabase: () => void;
  let store: typeof import("../../../src/services/automations/store");
  const originalDatabasePath = process.env.DATABASE_PATH;

  beforeAll(async () => {
    backendDir = mkdtempSync(path.join(os.tmpdir(), "deus-sqlite-parity-backend-"));
    process.env.DATABASE_PATH = path.join(backendDir, "deus.db");
    const database = await import("../../../src/lib/database");
    closeDatabase = database.closeDatabase;
    const opened = database.initDatabase();
    seedSession(opened, "session-1");
    store = await import("../../../src/services/automations/store");
  });

  afterAll(() => {
    closeDatabase();
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(backendDir, { recursive: true, force: true });
  });

  it("knows a session that no longer exists from one that does", () => {
    expect(store.sessionExists("session-1")).toBe(true);
    expect(store.sessionExists("deleted-session")).toBe(false);
  });

  it("writes an automation and its runs through named parameters", () => {
    store.upsertAutomation({
      id: "automation-1",
      name: "Nightly",
      prompt: "Check the build",
      cron: "0 3 * * *",
      timezone: "UTC",
      environment: "repo-env",
      repository_id: null,
      status: "active",
      paused_reason: null,
      session_policy: "fresh_session",
      model: null,
      thinking_level: null,
      next_run_at: null,
      last_run_at: null,
      consecutive_failures: 0,
      created_by: "user",
      workspace_id: null,
      organization_id: null,
      updated_at: "2026-11-17T00:00:00.000Z",
    });
    store.upsertRuns([
      {
        id: "run-1",
        automation_id: "automation-1",
        status: "running",
        trigger: "cron",
        provider_session_id: "provider-1",
        session_id: null,
        workspace_id: null,
        scheduled_at: null,
        started_at: "2026-11-17T03:00:00.000Z",
        completed_at: null,
        stop_reason: null,
        error_message: null,
        cost: 0.25,
        summary: null,
      },
    ]);
    expect(store.getAutomationRaw("automation-1")).toMatchObject({
      name: "Nightly",
      prompt: "Check the build",
      cron: "0 3 * * *",
    });
    expect(store.getRun("run-1")).toMatchObject({
      automation_id: "automation-1",
      provider_session_id: "provider-1",
      cost: 0.25,
    });
    expect(store.getAutomationRaw("missing")).toBeUndefined();
    expect(store.getRun("missing")).toBeUndefined();
  });
});
