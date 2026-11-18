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

  /** The compactions table rebuilt with `created_at` declared as given, plus `extra`. */
  function compactionsAs(createdAt: string, extra = ""): string {
    return `
      DROP TABLE compactions;
      CREATE TABLE compactions (
        compaction_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        status TEXT NOT NULL, trigger TEXT, pre_tokens INTEGER, post_tokens INTEGER, summary TEXT,
        created_at ${createdAt}${extra}
      );
    `;
  }

  it("stops on a column whose NOT NULL differs from the schema", async () => {
    databaseFile(compactionsAs("TEXT"));
    const { initDatabase } = await open();
    expectReset(initDatabase, "compactions.created_at should be NOT NULL.");
  });

  it("stops on a leftover column an insert would fail on", async () => {
    databaseFile(compactionsAs("TEXT NOT NULL DEFAULT (datetime('now'))", ", kind TEXT NOT NULL"));
    const { initDatabase } = await open();
    expectReset(initDatabase, "compactions.kind is no longer in the schema and is required.");
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
});
