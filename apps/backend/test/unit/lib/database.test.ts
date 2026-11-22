import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRELAUNCH_SCHEMA_RESET_HINT, SCHEMA_SQL } from "@shared/schema";

describe("database schema check at startup", () => {
  let originalDatabasePath: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalDatabasePath = process.env.DATABASE_PATH;
    tempDir = mkdtempSync(path.join(os.tmpdir(), "deus-db-test-"));
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }

    vi.doUnmock("@shared/schema");
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A database on disk made from the current schema, then changed by `alter`. */
  function databaseFile(alter: string): void {
    const dbPath = path.join(tempDir, "deus.db");
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    if (alter) db.exec(alter);
    db.close();
    process.env.DATABASE_PATH = dbPath;
  }

  async function open() {
    return import("../../../src/lib/database");
  }

  function expectReset(initDatabase: () => unknown, detail: string): void {
    expect(() => initDatabase()).toThrow(detail);
    // The failed handle is not kept: the next attempt checks again.
    expect(() => initDatabase()).toThrow(PRELAUNCH_SCHEMA_RESET_HINT);
  }

  it("upgrades a v0.3.18 database: chats numbered in their old order, first chats set, a new chat next, a second open changes nothing", async () => {
    const { SCHEMA_SQL_V0_3_18 } = await import("../../fixtures/schema-v0.3.18");
    const dbPath = path.join(tempDir, "old.db");
    const old = new Database(dbPath);
    old.exec(SCHEMA_SQL_V0_3_18);
    old.exec(`
      INSERT INTO repositories (id, name, root_path) VALUES ('r', 'shop', '/repos/shop');
      INSERT INTO workspaces (id, repository_id, slug, state, current_session_id) VALUES ('w1', 'r', 'one', 'ready', 'b');
      INSERT INTO workspaces (id, repository_id, slug, state, current_session_id) VALUES ('w2', 'r', 'two', 'ready', 'c');
      INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w3', 'r', 'none', 'error');
      INSERT INTO sessions (id, workspace_id) VALUES ('01a-first', 'w1');
      INSERT INTO sessions (id, workspace_id, is_hidden) VALUES ('01b-hidden', 'w1', 1);
      INSERT INTO sessions (id, workspace_id) VALUES ('01c-third', 'w1');
      INSERT INTO sessions (id, workspace_id) VALUES ('02a-only', 'w2');
    `);
    // Rows written long ago; a direct write, so the triggers do not move it.
    old.exec("DROP TRIGGER update_sessions_updated_at; DROP TRIGGER update_workspaces_updated_at;");
    old.exec(
      "UPDATE sessions SET updated_at = '2020-01-01 00:00:00'; UPDATE workspaces SET updated_at = '2020-01-01 00:00:00';"
    );
    old.close();
    process.env.DATABASE_PATH = dbPath;
    const { closeDatabase, initDatabase } = await open();
    const db = initDatabase();
    const chats = () =>
      db.prepare("SELECT id, chat FROM sessions ORDER BY workspace_id, chat").all();
    const firsts = () =>
      db.prepare("SELECT id, first_session_id FROM workspaces ORDER BY id").all();
    expect(chats()).toEqual([
      { id: "01a-first", chat: 1 },
      { id: "01b-hidden", chat: 2 },
      { id: "01c-third", chat: 3 },
      { id: "02a-only", chat: 1 },
    ]);
    expect(firsts()).toEqual([
      { id: "w1", first_session_id: "01a-first" },
      { id: "w2", first_session_id: "02a-only" },
      { id: "w3", first_session_id: null },
    ]);
    // The upgrade is not an update: the sidebar's recency order is kept.
    const stamps = () =>
      db
        .prepare(
          "SELECT id, updated_at FROM sessions UNION ALL SELECT id, updated_at FROM workspaces ORDER BY id"
        )
        .all() as { id: string; updated_at: string }[];
    expect(new Set(stamps().map((row) => row.updated_at))).toEqual(
      new Set(["2020-01-01 00:00:00"])
    );
    // Its triggers are back, and fire on a real update.
    db.prepare("UPDATE workspaces SET title = 't' WHERE id = 'w3'").run();
    expect(
      (
        db.prepare("SELECT updated_at FROM workspaces WHERE id = 'w3'").get() as {
          updated_at: string;
        }
      ).updated_at
    ).not.toBe("2020-01-01 00:00:00");
    // A new chat, whatever its id sorts as, takes the next number.
    db.prepare("INSERT INTO sessions (id, workspace_id) VALUES ('00-new', 'w1')").run();
    expect(db.prepare("SELECT chat FROM sessions WHERE id = '00-new'").get()).toEqual({ chat: 4 });
    const before = [chats(), firsts()];
    closeDatabase();
    const again = initDatabase();
    expect([
      again.prepare("SELECT id, chat FROM sessions ORDER BY workspace_id, chat").all(),
      again.prepare("SELECT id, first_session_id FROM workspaces ORDER BY id").all(),
    ]).toEqual(before);
    closeDatabase();
  });

  it("creates a fresh database from the schema, and opens it again", async () => {
    process.env.DATABASE_PATH = path.join(tempDir, "fresh.db");
    const { closeDatabase, initDatabase } = await open();
    const columns = initDatabase().pragma("table_info(sessions)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("agent_harness");
    closeDatabase();
    expect(() => initDatabase()).not.toThrow();
    closeDatabase();
  });

  it("stops on a column the schema has and the database lacks", async () => {
    databaseFile("ALTER TABLE workspaces DROP COLUMN organization_id");
    const { initDatabase } = await open();
    expectReset(initDatabase, "workspaces.organization_id is missing");
  });

  /** The compactions table rebuilt with its id and `created_at` declared as given, plus `extra`. */
  function compactionsAs({
    id = "TEXT PRIMARY KEY NOT NULL",
    createdAt = "TEXT NOT NULL DEFAULT (datetime('now'))",
    extra = "",
  }): string {
    return `
      DROP TABLE compactions;
      CREATE TABLE compactions (
        compaction_id ${id}, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        status TEXT NOT NULL, trigger TEXT, pre_tokens INTEGER, post_tokens INTEGER, summary TEXT,
        created_at ${createdAt}${extra}
      );
    `;
  }

  it.each([
    ["a NOT NULL", { createdAt: "TEXT DEFAULT (datetime('now'))" }, "created_at"],
    ["a default", { createdAt: "TEXT NOT NULL" }, "created_at"],
    ["a type", { createdAt: "INTEGER NOT NULL DEFAULT (datetime('now'))" }, "created_at"],
    ["a primary key", { id: "TEXT NOT NULL" }, "compaction_id"],
  ])("stops on a column whose %s differs from the schema", async (_, table, column) => {
    databaseFile(compactionsAs(table));
    const { initDatabase } = await open();
    expectReset(initDatabase, `compactions.${column} differs from the schema.`);
  });

  it("stops on a leftover column an insert would fail on", async () => {
    databaseFile(compactionsAs({ extra: ", kind TEXT NOT NULL" }));
    const { initDatabase } = await open();
    expectReset(initDatabase, "compactions.kind is no longer in the schema and is required.");
  });

  /** The database's schema version: SQLite moves it on every change to the schema. */
  function schemaVersion(): number {
    const db = new Database(process.env.DATABASE_PATH!);
    const version = db.pragma("schema_version", { simple: true }) as number;
    db.close();
    return version;
  }

  it("replaces a trigger whose body is older than the schema's, and starts", async () => {
    databaseFile(`
      DROP TRIGGER assign_message_seq;
      CREATE TRIGGER assign_message_seq AFTER INSERT ON messages BEGIN SELECT 1; END;
    `);
    const { closeDatabase, initDatabase } = await open();
    const sql = (db: Database.Database) =>
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'assign_message_seq'").get();
    const fresh = new Database(":memory:");
    fresh.exec(SCHEMA_SQL);
    expect(sql(initDatabase())).toEqual(sql(fresh));
    fresh.close();
    closeDatabase();
  });

  it("leaves a database it refuses as it was: the trigger it would replace is still the old one", async () => {
    const old = "CREATE TRIGGER assign_message_seq AFTER INSERT ON messages BEGIN SELECT 1; END";
    databaseFile(`
      DROP TRIGGER assign_message_seq;
      ${old};
      ALTER TABLE workspaces DROP COLUMN organization_id;
    `);
    const { initDatabase } = await open();
    expectReset(initDatabase, "workspaces.organization_id is missing");
    const db = new Database(process.env.DATABASE_PATH!);
    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'assign_message_seq'").get()
    ).toEqual({ sql: old });
    db.close();
  });

  it("changes nothing in a database that matches the schema: no trigger is dropped", async () => {
    databaseFile("");
    const before = schemaVersion();
    const { closeDatabase, initDatabase } = await open();
    initDatabase();
    closeDatabase();
    expect(schemaVersion()).toBe(before);
  });

  it("ignores a leftover nullable column", async () => {
    databaseFile("ALTER TABLE messages ADD COLUMN content TEXT");
    const { closeDatabase, initDatabase } = await open();
    expect(() => initDatabase()).not.toThrow();
    closeDatabase();
  });

  it("adds an additive column a database lacks, instead of stopping", async () => {
    vi.doMock("@shared/schema", async (original) => ({
      ...(await original<typeof import("@shared/schema")>()),
      ADDITIVE_COLUMNS: { workspaces: { organization_id: "TEXT" } },
    }));
    databaseFile("ALTER TABLE workspaces DROP COLUMN organization_id");
    const { closeDatabase, initDatabase } = await open();
    const columns = initDatabase().pragma("table_info(workspaces)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("organization_id");
    closeDatabase();
  });

  it("upgrades archives from before attribution without losing their fallback time", async () => {
    databaseFile(`ALTER TABLE workspaces DROP COLUMN archived_by;
      INSERT INTO repositories (id,name) VALUES ('repo','Project');
      INSERT INTO workspaces (id,repository_id,slug,state,updated_at) VALUES ('old','repo','old','archived','2026-08-16');`);
    const { initDatabase, closeDatabase } = await open();
    const row = initDatabase()
      .prepare(
        "SELECT archived_by, COALESCE(archived_at,updated_at) AS time FROM workspaces WHERE id='old'"
      )
      .get();
    expect(row).toEqual({ archived_by: null, time: "2026-08-16" });
    closeDatabase();
  });

  it("adds an additive column before the schema's index on it is created", async () => {
    vi.doMock("@shared/schema", async (original) => ({
      ...(await original<typeof import("@shared/schema")>()),
      ADDITIVE_COLUMNS: { automations: { repository_id: "TEXT" }, not_yet_a_table: { x: "TEXT" } },
    }));
    databaseFile(`
      DROP INDEX idx_automations_repository_id;
      ALTER TABLE automations DROP COLUMN repository_id;
    `);
    const { closeDatabase, initDatabase } = await open();
    const index = initDatabase()
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_automations_repository_id'")
      .get();
    expect(index).toEqual({ name: "idx_automations_repository_id" });
    closeDatabase();
  });
});
