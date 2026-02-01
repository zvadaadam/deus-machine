import { Hono } from 'hono';
import {
  getMcpServers, saveMcpServers,
  getCommands, saveCommand, deleteCommand,
  getAgents, saveAgent, deleteAgent,
  getHooks, saveHooks,
} from '../services/config.service';
import { ValidationError } from '../lib/errors';

const app = new Hono();

// MCP Servers
app.get('/config/mcp-servers', (c) => {
  return c.json(getMcpServers());
});

app.post('/config/mcp-servers', async (c) => {
  const { servers } = await c.req.json();
  if (!Array.isArray(servers)) throw new ValidationError('servers must be an array');
  const success = saveMcpServers(servers);
  return c.json({ success, servers });
});

// Commands
app.get('/config/commands', (c) => {
  return c.json(getCommands());
});

app.post('/config/commands', async (c) => {
  const { name, content } = await c.req.json();
  if (!name || !content) throw new ValidationError('name and content are required');
  const success = saveCommand(name, content);
  return c.json({ success, name, content });
});

app.delete('/config/commands/:name', (c) => {
  const success = deleteCommand(c.req.param('name'));
  return c.json({ success });
});

// Agents
app.get('/config/agents', (c) => {
  return c.json(getAgents());
});

app.post('/config/agents', async (c) => {
  const { id, ...agentData } = await c.req.json();
  if (!id) throw new ValidationError('id is required');
  const success = saveAgent(id, agentData);
  return c.json({ success, id, ...agentData });
});

app.delete('/config/agents/:id', (c) => {
  const success = deleteAgent(c.req.param('id'));
  return c.json({ success });
});

// Hooks
app.get('/config/hooks', (c) => {
  return c.json(getHooks());
});

app.post('/config/hooks', async (c) => {
  const { hooks } = await c.req.json();
  if (!hooks || typeof hooks !== 'object') throw new ValidationError('hooks must be an object');
  const success = saveHooks(hooks);
  return c.json({ success, hooks });
});

export default app;
