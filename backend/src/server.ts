import * as Sentry from '@sentry/node';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { initDatabase, closeDatabase, DB_PATH } from './lib/database';
import { closeAll as closeAllWsConnections } from './services/ws.service';
import { ensureRelayConnected, disconnectFromRelay } from './services/relay.service';
import { getSetting } from './services/settings.service';
import { AgentClient } from './services/agent-client';
import { handleAgentEvent, setRespondToAgent } from './services/agent-event-handler';

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

const remoteEnabled = getSetting("remote_access_enabled");
if (remoteEnabled === true) {
  ensureRelayConnected();
}

// Connect to agent-server (sidecar) if AGENT_SERVER_URL is set.
// The Rust process manager sets this env var after spawning the agent-server
// and parsing its LISTEN_URL=ws://... stdout line.
let agentClient: AgentClient | null = null;
const agentServerUrl = process.env.AGENT_SERVER_URL;
if (agentServerUrl) {
  agentClient = new AgentClient({
    url: agentServerUrl,
    onEvent: handleAgentEvent,
    onConnected: (agents) => {
      console.log(`[AgentClient] Connected to agent-server, agents: [${agents.map((a) => a.type).join(', ')}]`);
    },
    onDisconnected: () => {
      console.log('[AgentClient] Disconnected from agent-server');
    },
  });

  // Register the respond callback so tool relay can send results back to the agent-server
  setRespondToAgent((params) => agentClient!.sendTurnRespond(params));

  agentClient.connect();
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
  // Sentry's built-in onUnhandledRejectionIntegration captures and normalizes
  // rejection reasons automatically. We only log here for local visibility.
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  agentClient?.disconnect();
  disconnectFromRelay();
  closeAllWsConnections();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
