import { serve } from '@hono/node-server';
import { createApp } from './app';
import { initDatabase, closeDatabase, DB_PATH } from './lib/database';

/**
 * Hive Backend Server
 *
 * Handles workspace CRUD, sessions, repos, config, and stats.
 * Agent runtime (Claude SDK) is now managed by sidecar-v2 (Rust-spawned).
 */

// Initialize database
const db = initDatabase();

// Create Hono app
const app = createApp();

// Global variable to store actual port (used by health endpoint)
let actualServerPort: number | null = null;

export function getServerPort() {
  return actualServerPort;
}

// Start server with dynamic port allocation
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

const server = serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  actualServerPort = info.port;

  // CRITICAL: Machine-readable port output for Rust backend and dev.sh
  console.log(`[BACKEND_PORT]${info.port}`);

  console.log('\nHive Backend Server');
  console.log(`API Server: http://localhost:${info.port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('Server ready!\n');
});

// Global error handlers
process.on('uncaughtException', (error, origin) => {
  console.error('[FATAL] Uncaught Exception:', origin, error);
  try {
    closeDatabase();
  } catch {
    // Best-effort cleanup
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
