import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
