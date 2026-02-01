import { Hono } from 'hono';
import { getDatabase } from '../lib/database';

const app = new Hono();

app.get('/stats', (c) => {
  const db = getDatabase();
  const stats = {
    workspaces: (db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as any).count,
    workspaces_ready: (db.prepare("SELECT COUNT(*) as count FROM workspaces WHERE state = 'ready'").get() as any).count,
    workspaces_archived: (db.prepare("SELECT COUNT(*) as count FROM workspaces WHERE state = 'archived'").get() as any).count,
    repos: (db.prepare('SELECT COUNT(*) as count FROM repos').get() as any).count,
    sessions: (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as any).count,
    sessions_idle: (db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'idle'").get() as any).count,
    sessions_working: (db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'working'").get() as any).count,
    messages: (db.prepare('SELECT COUNT(*) as count FROM session_messages').get() as any).count
  };
  return c.json(stats);
});

export default app;
