import { Hono } from 'hono';
import { getDatabase } from '../lib/database';

const app = new Hono();

app.get('/stats', (c) => {
  const db = getDatabase();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM workspaces) as workspaces,
      (SELECT COUNT(*) FROM workspaces WHERE state = 'ready') as workspaces_ready,
      (SELECT COUNT(*) FROM workspaces WHERE state = 'archived') as workspaces_archived,
      (SELECT COUNT(*) FROM repos) as repos,
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'idle') as sessions_idle,
      (SELECT COUNT(*) FROM sessions WHERE status = 'working') as sessions_working,
      (SELECT COUNT(*) FROM session_messages) as messages
  `).get();
  return c.json(stats);
});

export default app;
