import { Hono } from 'hono';
import { getDatabase } from '../lib/database';
import { getStats } from '../db';

const app = new Hono();

app.get('/stats', (c) => {
  const db = getDatabase();
  return c.json(getStats(db));
});

export default app;
