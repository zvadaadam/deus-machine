import { serve } from '@hono/node-server';
import { createApp } from './app';
import { initDatabase, closeDatabase, DB_PATH } from './lib/database';
import { startSidecar, stopSidecar } from './sidecar';
import { stopAllClaudeSessions } from './services/claude.service';

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

  console.log('\nConductor Backend Server');
  console.log(`API Server: http://localhost:${info.port}`);
  console.log(`Database: ${DB_PATH}`);

  // Start sidecar with backend port
  process.env.BACKEND_PORT = info.port.toString();
  startSidecar(DB_PATH);

  console.log('Server ready!\n');
});

// Global error handlers
process.on('uncaughtException', (error, origin) => {
  console.error('[FATAL] Uncaught Exception:', origin, error);
  try {
    stopSidecar();
    stopAllClaudeSessions();
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
  stopSidecar();
  stopAllClaudeSessions();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
