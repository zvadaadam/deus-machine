import { Hono } from 'hono';
import {
  getMcpServers, saveMcpServers,
  getCommands, saveCommand, deleteCommand,
  getAgents, saveAgent, deleteAgent,
  getHooks, saveHooks,
} from '../services/config.service';
import { parseBody } from '../lib/validate';
import {
  SaveMcpServersBody,
  SaveCommandBody,
  SaveAgentBody,
  SaveHooksBody,
} from '../lib/schemas';

const app = new Hono();

// MCP Servers
app.get('/config/mcp-servers', (c) => {
  return c.json(getMcpServers());
});

app.post('/config/mcp-servers', async (c) => {
  const { servers } = parseBody(SaveMcpServersBody, await c.req.json());
  const success = saveMcpServers(servers);
  return c.json({ success, servers });
});

// Commands
app.get('/config/commands', (c) => {
  return c.json(getCommands());
});

app.post('/config/commands', async (c) => {
  const { name, content } = parseBody(SaveCommandBody, await c.req.json());
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
  const { id, ...agentData } = parseBody(SaveAgentBody, await c.req.json());
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
  const { hooks } = parseBody(SaveHooksBody, await c.req.json());
  const success = saveHooks(hooks);
  return c.json({ success, hooks });
});

export default app;
