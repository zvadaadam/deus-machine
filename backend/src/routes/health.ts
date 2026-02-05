import { Hono } from 'hono';
import { getDatabase } from '../lib/database';
import { getServerPort } from '../server';

const app = new Hono();

app.get('/health', (c) => {
  const db = getDatabase();
  // Note: Sidecar status removed - sidecar-v2 is managed by Rust, status via Tauri commands
  return c.json({
    app: 'conductor-backend',
    status: 'ok',
    port: getServerPort(),
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected',
  });
});

app.get('/port', (c) => {
  return c.json({ port: getServerPort() });
});

export default app;
