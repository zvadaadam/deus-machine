import { serve } from '@hono/node-server';
import { createApp } from './app';
import { initDatabase, closeDatabase, DB_PATH } from './lib/database';
import { closeAll as closeAllWsConnections } from './services/ws.service';
import { connectToRelay, disconnectFromRelay } from './services/relay.service';
import { getRelayCredentials } from './services/auth.service';
import { getSetting } from './services/settings.service';

/**
 * Hive Backend Server
 *
 * Handles workspace CRUD, sessions, repos, config, and stats.
 * Agent runtime (Claude SDK) is now managed by sidecar-v2 (Rust-spawned).
 */

// Initialize database
const db = initDatabase();

// Create Hono app + WebSocket injector
const { app, injectWebSocket } = createApp();

// Global variable to store actual port (used by health endpoint)
let actualServerPort: number | null = null;

export function getServerPort() {
  return actualServerPort;
}

// Start server with dynamic port allocation
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

// Bind 0.0.0.0 to accept connections from all interfaces.
// Remote access is gated by remoteGateMiddleware (rejects non-localhost when disabled).
const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: '0.0.0.0',
}, (info) => {
  actualServerPort = info.port;

  // CRITICAL: Machine-readable port output for Rust backend and dev.sh
  console.log(`[BACKEND_PORT]${info.port}`);

  console.log('\nHive Backend Server');
  console.log(`API Server: http://0.0.0.0:${info.port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('Server ready!\n');
});

// Inject WebSocket support into the HTTP server
injectWebSocket(server);

// Connect to relay if remote access is enabled and relay URL is configured
const remoteEnabled = getSetting("remote_access_enabled");
const relayUrl = getSetting("relay_url");
if (remoteEnabled === true && relayUrl) {
  const creds = getRelayCredentials();
  if (creds) {
    connectToRelay(relayUrl, creds.serverId, creds.relayToken);
  }
}

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
  disconnectFromRelay();
  closeAllWsConnections();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
