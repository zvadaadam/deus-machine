import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDb = {};
vi.mock('../../lib/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock('../../sidecar', () => ({
  getSidecarStatus: vi.fn(() => ({ running: true, connected: true })),
}));

vi.mock('../../server', () => ({
  getServerPort: vi.fn(() => 3000),
}));

import app from '../../routes/health';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /health', () => {
  it('returns 200 with full health status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.sidecar).toBe('running');
    expect(body.socket).toBe('connected');
  });

  it('includes app name as conductor-backend', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.app).toBe('conductor-backend');
  });

  it('includes timestamp and port', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.port).toBe(3000);
    expect(body.timestamp).toBeDefined();
    // Timestamp should be a valid ISO string
    expect(() => new Date(body.timestamp)).not.toThrow();
  });
});

describe('GET /port', () => {
  it('returns port from getServerPort', async () => {
    const res = await app.request('/port');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ port: 3000 });
  });
});
