import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../middleware/error-handler';

vi.mock('../../services/config.service', () => ({
  getMcpServers: vi.fn(() => [{ name: 'test-server' }]),
  saveMcpServers: vi.fn(() => true),
  getCommands: vi.fn(() => [{ name: 'test', content: 'echo test' }]),
  saveCommand: vi.fn(() => true),
  deleteCommand: vi.fn(() => true),
  getAgents: vi.fn(() => [{ id: 'agent-1' }]),
  saveAgent: vi.fn(() => true),
  deleteAgent: vi.fn(() => true),
  getHooks: vi.fn(() => ({ preCommit: 'lint' })),
  saveHooks: vi.fn(() => true),
}));

import configRoutes from '../../routes/config';
import { saveMcpServers, saveCommand, saveAgent } from '../../services/config.service';

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route('/', configRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCP Servers', () => {
  it('GET /config/mcp-servers returns array', async () => {
    const res = await app.request('/config/mcp-servers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: 'test-server' }]);
  });

  it('POST /config/mcp-servers with valid servers returns success', async () => {
    const res = await app.request('/config/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: [{ name: 's1', command: 'node' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveMcpServers).toHaveBeenCalledWith([{ name: 's1', command: 'node' }]);
  });

  it('POST /config/mcp-servers with non-array servers returns 400', async () => {
    const res = await app.request('/config/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: 'not-array' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Commands', () => {
  it('GET /config/commands returns array', async () => {
    const res = await app.request('/config/commands');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: 'test', content: 'echo test' }]);
  });

  it('POST /config/commands with valid data returns success', async () => {
    const res = await app.request('/config/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'build', content: 'npm run build' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveCommand).toHaveBeenCalledWith('build', 'npm run build');
  });

  it('POST /config/commands without name returns 400', async () => {
    const res = await app.request('/config/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'echo test' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /config/commands without content returns 400', async () => {
    const res = await app.request('/config/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'build' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /config/commands/:name returns success', async () => {
    const res = await app.request('/config/commands/test', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe('Agents', () => {
  it('GET /config/agents returns array', async () => {
    const res = await app.request('/config/agents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: 'agent-1' }]);
  });

  it('POST /config/agents with valid data returns success', async () => {
    const res = await app.request('/config/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'agent-2', name: 'Test Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveAgent).toHaveBeenCalledWith('agent-2', { name: 'Test Agent' });
  });

  it('POST /config/agents without id returns 400', async () => {
    const res = await app.request('/config/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Agent' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /config/agents/:id returns success', async () => {
    const res = await app.request('/config/agents/agent-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe('Hooks', () => {
  it('GET /config/hooks returns hooks object', async () => {
    const res = await app.request('/config/hooks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ preCommit: 'lint' });
  });

  it('POST /config/hooks with valid hooks returns success', async () => {
    const res = await app.request('/config/hooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hooks: { prePush: 'test' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('POST /config/hooks without hooks object returns 400', async () => {
    const res = await app.request('/config/hooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hooks: 'not-object' }),
    });
    expect(res.status).toBe(400);
  });
});
