import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";

describe("database pre-launch schema bootstrap", () => {
  let originalDatabasePath: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalDatabasePath = process.env.DATABASE_PATH;
    tempDir = mkdtempSync(path.join(os.tmpdir(), "deus-db-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }

    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a fresh database from the current schema", async () => {
    process.env.DATABASE_PATH = path.join(tempDir, "fresh.db");

    const { closeDatabase, initDatabase } = await import("../../../src/lib/database");
    const db = initDatabase();
    const columns = db.pragma("table_info(sessions)") as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain("agent_harness");
    expect(columns.map((column) => column.name)).toContain("error_category");

    closeDatabase();
  });

  it("throws a reset hint for stale pre-launch databases and does not cache the failed handle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dbPath = path.join(tempDir, "stale.db");
    const staleDb = new Database(dbPath);
    staleDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'claude'
      )
    `);
    staleDb.close();
    process.env.DATABASE_PATH = dbPath;

    const { initDatabase } = await import("../../../src/lib/database");

    expect(() => initDatabase()).toThrow(
      "Database schema is out of date for this pre-launch build."
    );
    expect(() => initDatabase()).toThrow("Reset it by deleting deus.db");
  });

  it("renames saved provider attribution without changing execution or accounting", async () => {
    const dbPath = path.join(tempDir, "attribution.db");
    const seed = new Database(dbPath);
    seed.exec(SCHEMA_SQL);
    seed.exec(`
      INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'repo', '/test/repo');
      INSERT INTO workspaces (id, repository_id, slug) VALUES ('workspace', 'repo', 'workspace');
      INSERT INTO sessions (id, workspace_id) VALUES ('session', 'workspace');
    `);
    const execution = { harness: "codex-app-server", model: "selected-model" };
    const source = {
      provider: "codex",
      source: "personal_account",
      authMethod: "subscription",
      account: { id: "saved-account", revision: "revision", label: "Personal" },
    };
    const values = [
      { execution, credentialSource: source },
      { execution, providerCredentialSource: source },
      {
        execution,
        credentialSource: { ...source, account: { ...source.account, id: "stale-account" } },
        providerCredentialSource: source,
      },
      { execution },
      null,
    ];
    for (const [index, value] of values.entries()) {
      seed
        .prepare(
          `INSERT INTO messages (id, session_id, seq, role, turn_attribution, cost)
        VALUES (?, 'session', ?, 'assistant', ?, 0)`
        )
        .run(String(index), index, value === null ? null : JSON.stringify(value));
    }
    seed.close();
    process.env.DATABASE_PATH = dbPath;
    const { initDatabase, closeDatabase } = await import("../../../src/lib/database");
    try {
      for (let opening = 0; opening < 2; opening++) {
        const rows = initDatabase()
          .prepare("SELECT turn_attribution, cost FROM messages ORDER BY seq")
          .all() as Array<{ turn_attribution: string | null; cost: number }>;
        expect(rows.map((row) => row.turn_attribution && JSON.parse(row.turn_attribution))).toEqual(
          [
            { execution, providerCredentialSource: source },
            { execution, providerCredentialSource: source },
            { execution, providerCredentialSource: source },
            { execution },
            null,
          ]
        );
        expect(rows.map((row) => row.cost)).toEqual([0, 0, 0, 0, 0]);
        closeDatabase();
      }
    } finally {
      closeDatabase();
    }
  });

  // The other direction: a database old enough to still CARRY a column the
  // current schema dropped. CREATE TABLE IF NOT EXISTS never alters an existing
  // table, so only this check forces the reset.
  it("throws a reset hint for a database that still has a retired column", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dbPath = path.join(tempDir, "retired-column.db");
    const staleDb = new Database(dbPath);
    staleDb.exec(SCHEMA_SQL);
    // `messages.content` was the pre-parts render path. Re-add it to simulate a
    // database created before it was dropped.
    staleDb.exec("ALTER TABLE messages ADD COLUMN content TEXT");
    staleDb.close();
    process.env.DATABASE_PATH = dbPath;

    const { initDatabase } = await import("../../../src/lib/database");

    expect(() => initDatabase()).toThrow("Found retired columns: messages.content");
    expect(() => initDatabase()).toThrow("Reset it by deleting deus.db");
  });
});
