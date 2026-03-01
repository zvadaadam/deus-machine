import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  getMcpServers, saveMcpServers,
  getCommands, saveCommand, deleteCommand,
  getAgents, saveAgent, deleteAgent,
  getHooks, saveHooks,
  getSkills, saveSkill, deleteSkill,
} from '../services/config.service';
import { parseBody } from '../lib/validate';
import { ValidationError, NotFoundError } from '../lib/errors';
import {
  SaveMcpServersBody,
  SaveCommandBody,
  SaveAgentBody,
  SaveHooksBody,
  SaveSkillBody,
} from '../lib/schemas';

const app = new Hono();

/**
 * Extract project path from scope query params.
 * Returns undefined for global scope, repoPath for project scope.
 * Backward compatible: no params = global.
 */
function extractProjectPath(c: Context): string | undefined {
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
app.get('/config/mcp-servers', (c) => {
  const projectPath = extractProjectPath(c);
  return c.json(getMcpServers(projectPath));
});

app.post('/config/mcp-servers', async (c) => {
  const projectPath = extractProjectPath(c);
  const { servers } = parseBody(SaveMcpServersBody, await c.req.json());
  saveMcpServers(servers, projectPath);
  return c.json({ success: true, servers });
});

// Commands
app.get('/config/commands', (c) => {
  const projectPath = extractProjectPath(c);
  return c.json(getCommands(projectPath));
});

app.post('/config/commands', async (c) => {
  const projectPath = extractProjectPath(c);
  const { name, content } = parseBody(SaveCommandBody, await c.req.json());
  saveCommand(name, content, projectPath);
  return c.json({ success: true, name, content });
});

app.delete('/config/commands/:name', (c) => {
  const projectPath = extractProjectPath(c);
  const found = deleteCommand(c.req.param('name'), projectPath);
  if (!found) throw new NotFoundError(`Command '${c.req.param('name')}' not found`);
  return c.json({ success: true });
});

// Agents
app.get('/config/agents', (c) => {
  const projectPath = extractProjectPath(c);
  return c.json(getAgents(projectPath));
});

app.post('/config/agents', async (c) => {
  const projectPath = extractProjectPath(c);
  const { id, ...agentData } = parseBody(SaveAgentBody, await c.req.json());
  saveAgent(id, agentData, projectPath);
  return c.json({ success: true, id, ...agentData });
});

app.delete('/config/agents/:id', (c) => {
  const projectPath = extractProjectPath(c);
  const found = deleteAgent(c.req.param('id'), projectPath);
  if (!found) throw new NotFoundError(`Agent '${c.req.param('id')}' not found`);
  return c.json({ success: true });
});

// Hooks
app.get('/config/hooks', (c) => {
  const projectPath = extractProjectPath(c);
  return c.json(getHooks(projectPath));
});

app.post('/config/hooks', async (c) => {
  const projectPath = extractProjectPath(c);
  const { hooks } = parseBody(SaveHooksBody, await c.req.json());
  saveHooks(hooks, projectPath);
  return c.json({ success: true, hooks });
});

// Skills
app.get('/config/skills', (c) => {
  const projectPath = extractProjectPath(c);
  return c.json(getSkills(projectPath));
});

app.post('/config/skills', async (c) => {
  const projectPath = extractProjectPath(c);
  const { name, content } = parseBody(SaveSkillBody, await c.req.json());
  saveSkill(name, content, projectPath);
  return c.json({ success: true, name, content });
});

app.delete('/config/skills/:name', (c) => {
  const projectPath = extractProjectPath(c);
  const found = deleteSkill(c.req.param('name'), projectPath);
  if (!found) throw new NotFoundError(`Skill '${c.req.param('name')}' not found`);
  return c.json({ success: true });
});

export default app;
