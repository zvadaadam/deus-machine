import * as Sentry from '@sentry/node';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { initDatabase, closeDatabase, DB_PATH } from './lib/database';
import { closeAll as closeAllWsConnections } from './services/ws.service';
import { connectToRelay, disconnectFromRelay } from './services/relay.service';
import { getRelayCredentials, generateRelayCredentials } from './services/auth.service';
import { getSetting, saveSetting } from './services/settings.service';

// Initialize Sentry before anything else.
// DSN passed as env var from Rust process manager (not hardcoded — open source repo).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    sendDefaultPii: true,
    initialScope: { tags: { process: 'backend' } },
  });
}

/**
 * OpenDevs Backend Server
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

  console.log('\nOpenDevs Backend Server');
  console.log(`API Server: http://0.0.0.0:${info.port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('Server ready!\n');
});

// Inject WebSocket support into the HTTP server
injectWebSocket(server);

// Connect to relay if remote access is enabled.
// Auto-provisions relay URL and credentials if missing (same logic as settings route).
const remoteEnabled = getSetting("remote_access_enabled");
if (remoteEnabled === true) {
  let relayUrl = getSetting("relay_url") as string | null;
  if (!relayUrl) {
    relayUrl = "wss://relay.opendevs.sh";
    saveSetting("relay_url", relayUrl);
  }
  let creds = getRelayCredentials();
  if (!creds) {
    creds = generateRelayCredentials();
  }
  connectToRelay(relayUrl, creds.serverId, creds.relayToken);
}

// Global error handlers
process.on('uncaughtException', (error, origin) => {
  console.error('[FATAL] Uncaught Exception:', origin, error);
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => {
    try { closeDatabase(); } catch {}
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  Sentry.captureException(reason);
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
