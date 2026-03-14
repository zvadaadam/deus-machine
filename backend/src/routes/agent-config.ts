import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  getMcpServers, saveMcpServers,
  getCommands, saveCommand, deleteCommand,
  getAgents, saveAgent, deleteAgent,
  getHooks, saveHooks,
  getSkills, saveSkill, deleteSkill,
} from '../services/agent-config.service';
import { ValidationError, NotFoundError } from '../lib/errors';
import {
  parseBody,
  SaveMcpServersBody,
  SaveCommandBody,
  SaveAgentBody,
  SaveHooksBody,
  SaveSkillBody,
} from '../lib/schemas';

const app = new Hono();

/**
 * Resolve config scope from query params.
 * Returns undefined for global scope, repoPath for project scope.
 * Backward compatible: no params = global.
 */
function resolveScope(c: Context): string | undefined {
  const scope = c.req.query('scope') || 'global';
  if (scope === 'project') {
    const repoPath = c.req.query('repoPath');
    if (!repoPath) {
      throw new ValidationError('repoPath query param required for project scope');
    }
    return repoPath;
  }
  if (scope !== 'global') {
    throw new ValidationError(`Invalid scope '${scope}': must be 'global' or 'project'`);
  }
  return undefined;
}

// MCP Servers
app.get('/agent-config/mcp-servers', (c) => {
  const projectPath = resolveScope(c);
  return c.json(getMcpServers(projectPath));
});

app.post('/agent-config/mcp-servers', async (c) => {
  const projectPath = resolveScope(c);
  const { servers } = parseBody(SaveMcpServersBody, await c.req.json());
  saveMcpServers(servers, projectPath);
  return c.json({ success: true, servers });
});

// Commands
app.get('/agent-config/commands', (c) => {
  const projectPath = resolveScope(c);
  return c.json(getCommands(projectPath));
});

app.post('/agent-config/commands', async (c) => {
  const projectPath = resolveScope(c);
  const { name, content } = parseBody(SaveCommandBody, await c.req.json());
  saveCommand(name, content, projectPath);
  return c.json({ success: true, name, content });
});

app.delete('/agent-config/commands/:name', (c) => {
  const projectPath = resolveScope(c);
  const found = deleteCommand(c.req.param('name'), projectPath);
  if (!found) throw new NotFoundError(`Command '${c.req.param('name')}' not found`);
  return c.json({ success: true });
});

// Agents
app.get('/agent-config/agents', (c) => {
  const projectPath = resolveScope(c);
  return c.json(getAgents(projectPath));
});

app.post('/agent-config/agents', async (c) => {
  const projectPath = resolveScope(c);
  const { id, ...agentData } = parseBody(SaveAgentBody, await c.req.json());
  saveAgent(id, agentData, projectPath);
  return c.json({ success: true, id, ...agentData });
});

app.delete('/agent-config/agents/:id', (c) => {
  const projectPath = resolveScope(c);
  const found = deleteAgent(c.req.param('id'), projectPath);
  if (!found) throw new NotFoundError(`Agent '${c.req.param('id')}' not found`);
  return c.json({ success: true });
});

// Hooks
app.get('/agent-config/hooks', (c) => {
  const projectPath = resolveScope(c);
  return c.json(getHooks(projectPath));
});

app.post('/agent-config/hooks', async (c) => {
  const projectPath = resolveScope(c);
  const { hooks } = parseBody(SaveHooksBody, await c.req.json());
  saveHooks(hooks, projectPath);
  return c.json({ success: true, hooks });
});

// Skills
app.get('/agent-config/skills', (c) => {
  const projectPath = resolveScope(c);
  return c.json(getSkills(projectPath));
});

app.post('/agent-config/skills', async (c) => {
  const projectPath = resolveScope(c);
  const { name, content } = parseBody(SaveSkillBody, await c.req.json());
  saveSkill(name, content, projectPath);
  return c.json({ success: true, name, content });
});

app.delete('/agent-config/skills/:name', (c) => {
  const projectPath = resolveScope(c);
  const found = deleteSkill(c.req.param('name'), projectPath);
  if (!found) throw new NotFoundError(`Skill '${c.req.param('name')}' not found`);
  return c.json({ success: true });
});

export default app;
