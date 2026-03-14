import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createNodeWebSocket } from '@hono/node-ws';
import { errorHandler } from './middleware/error-handler';
import { remoteGateMiddleware } from './middleware/remote-gate';
import { authMiddleware } from './middleware/remote-auth';
import { validateDeviceToken } from './services/auth.service';
import {
  addConnection,
  removeConnection,
  handleProtocolMessage,
} from './services/ws.service';
import { removeSubs as removeQuerySubs } from './services/query-engine';
import { getRelayStatus } from './services/relay.service';
import { isLocalhost, getClientIp } from './lib/network';
import healthRoutes from './routes/health';
import workspaceRoutes from './routes/workspaces';
import sessionRoutes from './routes/sessions';
import repoRoutes from './routes/repos';
import configRoutes from './routes/config';
import settingsRoutes from './routes/settings';
import statsRoutes from './routes/stats';
import onboardingRoutes from './routes/onboarding';
import authRoutes from './routes/remote-auth';
import gateRoutes from './routes/gate';
import notifyRoutes from './routes/notify';

export function createApp() {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // Middleware — order matters:
  // 1. Remote gate rejects non-localhost when remote access is disabled
  // 2. CORS headers for browser requests
  // 3. Auth validates Bearer tokens for remote clients (localhost exempt)
  app.use('*', remoteGateMiddleware);
  app.use('*', cors());
  app.use('/api/*', authMiddleware);

  // Mount route groups
  // Note: Sidecar routes removed - agent runtime now managed by sidecar-v2 (Rust-spawned)
  app.route('/api', healthRoutes);
  app.route('/api', authRoutes);
  app.route('/api', workspaceRoutes);
  app.route('/api', sessionRoutes);
  app.route('/api', repoRoutes);
  app.route('/api', configRoutes);
  app.route('/api', settingsRoutes);
  app.route('/api', statsRoutes);
  app.route('/api', notifyRoutes);
  app.route('/api', onboardingRoutes);

  // Browser gate page — serves pairing form at "/" for remote clients
  app.route('', gateRoutes);

  // Relay status endpoint
  app.get('/api/relay/status', (c) => {
    return c.json(getRelayStatus());
  });

  // WebSocket route for remote access.
  // Localhost connections are auto-authenticated. Remote clients must send
  // { type: "initialize", token: "..." } as their first message.
  app.get('/ws', upgradeWebSocket((c) => {
    const ip = getClientIp(c);
    const isLocal = isLocalhost(ip);
    let connectionId: string | null = null;

    return {
      onOpen(_evt, ws) {
        if (isLocal) {
          // Desktop/localhost connections skip token auth
          connectionId = addConnection(ws, null);
          ws.send(JSON.stringify({ type: 'connected', connectionId }));
        }
        // Remote clients stay unauthenticated until initialize message
      },

      onMessage(evt, ws) {
        let msg: Record<string, unknown>;
        try {
          const raw = typeof evt.data === 'string' ? evt.data : String(evt.data);
          msg = JSON.parse(raw);
        } catch {
          return; // Ignore malformed messages
        }

        // Unauthenticated remote client — must initialize first
        if (!connectionId) {
          if (msg.type === 'initialize' && typeof msg.token === 'string') {
            const device = validateDeviceToken(msg.token);
            if (device) {
              connectionId = addConnection(ws, device.id);
              ws.send(JSON.stringify({ type: 'connected', connectionId }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
              ws.close(4001, 'Invalid token');
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Must send initialize with token' }));
            ws.close(4001, 'Not authenticated');
          }
          return;
        }

        // Authenticated — handle protocol messages (shared with relay virtual connections)
        handleProtocolMessage(connectionId, msg);
      },

      onClose() {
        if (connectionId) {
          removeQuerySubs(connectionId);
          removeConnection(connectionId);
          connectionId = null;
        }
      },
    };
  }));

  // Centralized error handling
  app.onError(errorHandler);

  return { app, injectWebSocket };
}
