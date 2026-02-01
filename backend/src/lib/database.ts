import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(
  process.env.HOME!,
  'Library/Application Support/com.conductor.app/conductor.db'
);

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

  console.log('Opening database:', DB_PATH);

  try {
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');

    // Ensure settings table exists
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    console.log('Database connected');
    return dbInstance;
  } catch (error) {
    console.error('Failed to open database:', error);
    throw error;
  }
}

function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

function closeDatabase(): void {
  if (dbInstance) {
    console.log('Closing database connection');
    dbInstance.close();
    dbInstance = null;
  }
}

export { initDatabase, getDatabase, closeDatabase, DB_PATH };
