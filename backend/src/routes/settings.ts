import { Hono } from 'hono';
import { getAllSettings, saveSetting } from '../services/settings.service';
import { ValidationError } from '../lib/errors';

const app = new Hono();

app.get('/settings', (c) => {
  return c.json(getAllSettings());
});

app.post('/settings', async (c) => {
  const { key, value } = await c.req.json();
  if (!key) throw new ValidationError('key is required');
  saveSetting(key, value);
  return c.json({ success: true, key, value });
});

export default app;
