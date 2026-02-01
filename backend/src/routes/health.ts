import { Hono } from 'hono';
import { getSidecarStatus } from '../sidecar';
import { getDatabase } from '../lib/database';
import { getServerPort } from '../server';

const app = new Hono();

app.get('/health', (c) => {
  const db = getDatabase();
  const sidecarStatus = getSidecarStatus();
  return c.json({
    app: 'conductor-backend',
    status: 'ok',
    port: getServerPort(),
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected',
    sidecar: sidecarStatus.running ? 'running' : 'stopped',
    socket: sidecarStatus.connected ? 'connected' : 'disconnected'
  });
});

app.get('/port', (c) => {
  return c.json({ port: getServerPort() });
});

export default app;
