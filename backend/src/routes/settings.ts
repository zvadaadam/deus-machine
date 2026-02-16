import { Hono } from 'hono';
import { getAllSettings, saveSetting } from '../services/settings.service';
import { parseBody } from '../lib/validate';
import { SaveSettingBody } from '../lib/schemas';

const app = new Hono();

app.get('/settings', (c) => {
  return c.json(getAllSettings());
});

app.post('/settings', async (c) => {
  const { key, value } = parseBody(SaveSettingBody, await c.req.json());
  saveSetting(key, value);
  return c.json({ success: true, key, value });
});

export default app;
