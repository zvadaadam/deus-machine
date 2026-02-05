// sidecar/db/index.ts
// SQLite connection manager for sidecar-v2 message persistence.
// Uses better-sqlite3 for synchronous writes (same as backend).

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

const DEFAULT_DB_PATH = path.join(
  process.env.HOME || os.homedir(),
  "Library/Application Support/com.conductor.app/conductor.db"
);

let dbInstance: Database.Database | null = null;
let dbClosed = false;

/**
 * Initialize and return the database connection.
 * Uses DATABASE_PATH env var if set, otherwise defaults to production path.
 */
export function initDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }
  if (dbClosed) {
    throw new Error("[SIDECAR-V2] Database was explicitly closed and cannot be re-opened");
  }

  const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

  // Ensure parent directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  console.log("[SIDECAR-V2] Opening database:", dbPath);

  try {
    dbInstance = new Database(dbPath);
    // Enable WAL mode for concurrent access (backend may also be writing)
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("busy_timeout = 5000");

    console.log("[SIDECAR-V2] Database connected");
    return dbInstance;
  } catch (error) {
    console.error("[SIDECAR-V2] Failed to open database:", error);
    throw error;
  }
}

/**
 * Get the initialized database instance.
 * Throws if not initialized.
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    // Auto-initialize if not done yet
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    console.log("[SIDECAR-V2] Closing database connection");
    dbInstance.pragma("optimize");
    dbInstance.close();
    dbInstance = null;
    dbClosed = true;
  }
}

export { DEFAULT_DB_PATH };
