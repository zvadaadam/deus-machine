import type BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { resolveDefaultDatabasePath } from "../../../../shared/runtime";
import {
  PRELAUNCH_REQUIRED_COLUMNS,
  PRELAUNCH_SCHEMA_RESET_HINT,
  SCHEMA_SQL,
} from "@shared/schema";
import { openSqliteDatabase } from "./sqlite";

const DEFAULT_DB_PATH = resolveDefaultDatabasePath({
  platform: process.platform,
  homeDir: process.env.HOME || os.homedir(),
  appData: process.env.APPDATA,
  xdgDataHome: process.env.XDG_DATA_HOME,
});

const DB_PATH = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

let dbInstance: BetterSqlite3.Database | null = null;

interface TableInfoRow {
  name: string;
}

function assertPrelaunchSchemaCurrent(db: BetterSqlite3.Database): void {
  const missing: string[] = [];

  for (const [table, requiredColumns] of Object.entries(PRELAUNCH_REQUIRED_COLUMNS)) {
    const rows = db.pragma(`table_info(${table})`) as TableInfoRow[];
    if (rows.length === 0) {
      missing.push(`${table}.*`);
      continue;
    }

    const actualColumns = new Set(rows.map((row) => row.name));
    for (const column of requiredColumns) {
      if (!actualColumns.has(column)) {
        missing.push(`${table}.${column}`);
      }
    }
  }

  if (missing.length > 0) {
    throw prelaunchSchemaError(`Missing columns/tables: ${missing.join(", ")}`);
  }
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

    // Pre-launch policy: SCHEMA_SQL is the source of truth. We create fresh
    // databases from it directly, then fail fast with a reset hint if an old
    // local database still has a pre-launch schema shape.
    try {
      dbInstance.exec(SCHEMA_SQL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw prelaunchSchemaError(`Schema initialization failed: ${message}`);
    }
    assertPrelaunchSchemaCurrent(dbInstance);

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
