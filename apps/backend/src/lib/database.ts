import type BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { resolveDefaultDatabasePath } from "../../../../shared/runtime";
import { ADDITIVE_COLUMNS, PRELAUNCH_SCHEMA_RESET_HINT, SCHEMA_SQL } from "@shared/schema";
import { openSqliteDatabase } from "./sqlite";

const DEFAULT_DB_PATH = resolveDefaultDatabasePath({
  platform: process.platform,
  homeDir: process.env.HOME || os.homedir(),
  xdgDataHome: process.env.XDG_DATA_HOME,
});

const DB_PATH = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

let dbInstance: BetterSqlite3.Database | null = null;

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

function columnsOf(db: BetterSqlite3.Database, table: string): Map<string, ColumnInfo> {
  const rows = db.prepare("SELECT * FROM pragma_table_info(?)").all(table) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

/**
 * Add the columns of ADDITIVE_COLUMNS a database lacks. CREATE TABLE IF NOT
 * EXISTS never alters an existing table, so this is how a nullable or
 * defaulted column reaches an existing database without a reset.
 */
function applyAdditiveColumns(db: BetterSqlite3.Database): void {
  for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
    const existing = columnsOf(db, table);
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * The database must match SCHEMA_SQL: every column the schema has, with its
 * NOT NULL, and no leftover column an insert would fail on (NOT NULL with no
 * default). A leftover nullable column is harmless and ignored.
 */
function assertSchemaCurrent(db: BetterSqlite3.Database): void {
  const fresh = openSqliteDatabase(":memory:");
  const stale: string[] = [];
  try {
    fresh.exec(SCHEMA_SQL);
    const tables = fresh
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
      const want = columnsOf(fresh, table);
      const have = columnsOf(db, table);
      for (const [name, column] of want) {
        const found = have.get(name);
        if (!found) stale.push(`${table}.${name} is missing`);
        else if (found.notnull !== column.notnull)
          stale.push(`${table}.${name} should be ${column.notnull ? "NOT NULL" : "nullable"}`);
      }
      for (const [name, found] of have) {
        if (!want.has(name) && found.notnull && found.dflt_value === null)
          stale.push(`${table}.${name} is no longer in the schema and is required`);
      }
    }
  } finally {
    fresh.close();
  }
  if (stale.length > 0) throw prelaunchSchemaError(`${stale.join("; ")}.`);
}

function prelaunchSchemaError(detail: string): Error {
  return new Error(
    [
      "Database schema is out of date for this pre-launch build.",
      detail,
      PRELAUNCH_SCHEMA_RESET_HINT,
    ].join(" ")
  );
}

function initDatabase(): BetterSqlite3.Database {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure parent directory exists (first launch)
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  console.log("Opening database:", DB_PATH);

  try {
    dbInstance = openSqliteDatabase(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("busy_timeout = 5000");
    dbInstance.pragma("optimize");

    // SCHEMA_SQL is the source of truth: a fresh database is created from it,
    // and one that does not match it stops here with the reset hint.
    try {
      dbInstance.exec(SCHEMA_SQL);
      applyAdditiveColumns(dbInstance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw prelaunchSchemaError(`Schema initialization failed: ${message}`);
    }
    assertSchemaCurrent(dbInstance);

    console.log("Database connected");
    return dbInstance;
  } catch (error) {
    if (dbInstance) {
      try {
        dbInstance.close();
      } finally {
        dbInstance = null;
      }
    }
    console.error("Failed to open database:", error);
    throw error;
  }
}

function getDatabase(): BetterSqlite3.Database {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return dbInstance;
}

function closeDatabase(): void {
  if (dbInstance) {
    console.log("Closing database connection");
    dbInstance.pragma("optimize");
    dbInstance.close();
    dbInstance = null;
  }
}

export { initDatabase, getDatabase, closeDatabase, DB_PATH };
