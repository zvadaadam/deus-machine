import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { resolveDefaultDatabasePath } from "../../../../shared/runtime";
import { SCHEMA_SQL, MIGRATIONS, isExpectedMigrationError } from "@shared/schema";

const DEFAULT_DB_PATH = resolveDefaultDatabasePath({
  platform: process.platform,
  homeDir: process.env.HOME || os.homedir(),
  appData: process.env.APPDATA,
  xdgDataHome: process.env.XDG_DATA_HOME,
});

const DB_PATH = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

let dbInstance: Database.Database | null = null;

function runMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (!isExpectedMigrationError(sql, msg)) {
        throw e;
      }
    }
  }
}

function isMissingColumnError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("no such column");
}

function initializeSchema(db: Database.Database): void {
  try {
    db.exec(SCHEMA_SQL);
  } catch (error) {
    if (!isMissingColumnError(error)) {
      throw error;
    }

    console.warn("Schema creation hit a missing column; applying migrations before retrying");
    runMigrations(db);
    db.exec(SCHEMA_SQL);
    return;
  }

  runMigrations(db);
}

function initDatabase(): Database.Database {
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
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("busy_timeout = 5000");
    dbInstance.pragma("optimize");

    // Create all tables, indexes, and triggers (idempotent), with a migration
    // retry for existing DBs where new indexes reference not-yet-added columns.
    initializeSchema(dbInstance);

    console.log("Database connected");
    return dbInstance;
  } catch (error) {
    console.error("Failed to open database:", error);
    throw error;
  }
}

function getDatabase(): Database.Database {
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
