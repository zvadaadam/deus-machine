import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../middleware/error-handler';

const mockStmt = { get: vi.fn() };
const mockDb = { prepare: vi.fn(() => mockStmt) };

vi.mock('../../lib/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

import { withWorkspace, computeWorkspacePath } from '../../middleware/workspace-loader';

const createTestApp = () => {
  const app = new Hono();
  app.get('/test/:id', withWorkspace, (c) => {
    return c.json({
      workspace: c.get('workspace'),
      workspacePath: c.get('workspacePath'),
    });
  });
  app.onError(errorHandler);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
});

describe('withWorkspace middleware', () => {
  it('returns workspace data and computed path when found', async () => {
    mockStmt.get.mockReturnValue({
      id: 'ws-1',
      root_path: '/repo',
      directory_name: 'tokyo',
      default_branch: 'main',
    });

    const app = createTestApp();
    const res = await app.request('/test/ws-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace).toEqual({
      id: 'ws-1',
      root_path: '/repo',
      directory_name: 'tokyo',
      default_branch: 'main',
    });
    expect(body.workspacePath).toBe('/repo/.hive/tokyo');
  });

  it('returns 404 when workspace is not found', async () => {
    mockStmt.get.mockReturnValue(undefined);

    const app = createTestApp();
    const res = await app.request('/test/missing');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Workspace not found');
  });

  it('returns 404 when root_path is null', async () => {
    mockStmt.get.mockReturnValue({
      id: 'ws-1',
      root_path: null,
      directory_name: 'tokyo',
    });

    const app = createTestApp();
    const res = await app.request('/test/ws-1');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Workspace not found');
  });

  it('returns 404 when directory_name is null', async () => {
    mockStmt.get.mockReturnValue({
      id: 'ws-1',
      root_path: '/repo',
      directory_name: null,
    });

    const app = createTestApp();
    const res = await app.request('/test/ws-1');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Workspace not found');
  });

  it('queries database with the correct id parameter', async () => {
    mockStmt.get.mockReturnValue({
      id: 'ws-42',
      root_path: '/projects',
      directory_name: 'paris',
      default_branch: 'develop',
    });

    const app = createTestApp();
    await app.request('/test/ws-42');

    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockStmt.get).toHaveBeenCalledWith('ws-42');
  });

});

describe('computeWorkspacePath', () => {
  it('returns .hive path from root_path and directory_name', () => {
    expect(computeWorkspacePath({
      root_path: '/repo',
      directory_name: 'tokyo',
    })).toBe('/repo/.hive/tokyo');
  });

  it('returns empty string when root_path is missing', () => {
    expect(computeWorkspacePath({
      directory_name: 'tokyo',
    })).toBe('');
  });

  it('returns empty string when directory_name is missing', () => {
    expect(computeWorkspacePath({
      root_path: '/repo',
    })).toBe('');
  });
});
