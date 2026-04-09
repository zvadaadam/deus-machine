import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { resolveDefaultDatabasePath } from "../../../../shared/runtime";
import { SCHEMA_SQL, MIGRATIONS } from "@shared/schema";

const DEFAULT_DB_PATH = resolveDefaultDatabasePath({
  platform: process.platform,
  homeDir: process.env.HOME || os.homedir(),
  appData: process.env.APPDATA,
  xdgDataHome: process.env.XDG_DATA_HOME,
});

const DB_PATH = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

let dbInstance: Database.Database | null = null;

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

    // Create all tables, indexes, and triggers (idempotent)
    dbInstance.exec(SCHEMA_SQL);

    // Post-launch migrations: add new columns to existing tables.
    // Each ALTER TABLE may fail with "duplicate column" if already applied — skip those.
    for (const sql of MIGRATIONS) {
      try {
        dbInstance.exec(sql);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (!msg.includes("duplicate column") && !msg.includes("no such table")) throw e;
      }
    }

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
