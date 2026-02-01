import { Hono } from 'hono';
import { getSidecarStatus, sendToSidecar } from '../sidecar';

const app = new Hono();

app.get('/sidecar/status', (c) => {
  return c.json(getSidecarStatus());
});

app.post('/sidecar/command', async (c) => {
  const { command, data } = await c.req.json();
  const sent = sendToSidecar({ command, data });
  if (sent) return c.json({ success: true, message: 'Command sent to sidecar' });
  return c.json({ error: 'Failed to send command' }, 500);
});

export default app;
