/**
 * Database Module
 *
 * Handles all database initialization and provides a singleton instance
 * of the SQLite database connection using better-sqlite3.
 *
 * The database stores:
 * - Workspaces: Individual working directories with Git worktrees
 * - Sessions: Claude CLI conversation sessions
 * - Messages: User and assistant messages within sessions
 * - Repositories: Git repositories that contain workspaces
 * - Settings: Application configuration
 * - Attachments: File attachments for messages
 *
 * @module database
 */

const Database = require('better-sqlite3');
const path = require('path');

/**
 * Path to the Conductor SQLite database
 * Located in the user's Application Support directory
 * @type {string}
 */
const DB_PATH = path.join(
  process.env.HOME,
  'Library/Application Support/com.conductor.app/conductor.db'
);

/**
 * Singleton database instance
 * @type {Database.Database}
 */
let dbInstance = null;

/**
 * Initialize and return the database connection
 *
 * Creates a singleton instance that persists across the application.
 * The database is opened in read-write mode to allow workspace creation
 * and message storage.
 *
 * @returns {Database.Database} The SQLite database instance
 * @throws {Error} If database cannot be opened
 */
function initDatabase() {
  if (dbInstance) {
    return dbInstance;
  }

  console.log('📦 Opening LIVE database:', DB_PATH);

  try {
    dbInstance = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    dbInstance.pragma('journal_mode = WAL');

    // Enable foreign keys
    dbInstance.pragma('foreign_keys = ON');

    console.log('✅ Database connected successfully');

    return dbInstance;
  } catch (error) {
    console.error('❌ Failed to open database:', error);
    throw error;
  }
}

/**
 * Get the current database instance
 *
 * @returns {Database.Database} The database instance
 * @throws {Error} If database hasn't been initialized
 */
function getDatabase() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

/**
 * Close the database connection
 *
 * Should be called during application shutdown to ensure
 * all pending writes are flushed.
 */
function closeDatabase() {
  if (dbInstance) {
    console.log('👋 Closing database connection');
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  DB_PATH
};
