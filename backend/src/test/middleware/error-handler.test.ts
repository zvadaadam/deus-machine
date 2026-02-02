import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../middleware/error-handler';
import { NotFoundError, ValidationError, ConflictError, AppError } from '../../lib/errors';

const createTestApp = () => {
  const app = new Hono();
  app.get('/not-found', () => { throw new NotFoundError(); });
  app.get('/not-found-custom', () => { throw new NotFoundError('Custom not found'); });
  app.get('/validation', () => { throw new ValidationError('Bad input', { field: 'name' }); });
  app.get('/conflict', () => { throw new ConflictError('Already exists'); });
  app.get('/app-error', () => { throw new AppError(422, 'Unprocessable', { reason: 'test' }); });
  app.get('/generic', () => { throw new Error('Something broke'); });
  app.onError(errorHandler);
  return app;
};

describe('errorHandler', () => {
  it('returns 404 with default message for NotFoundError', async () => {
    const app = createTestApp();
    const res = await app.request('/not-found');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('returns 404 with custom message for NotFoundError', async () => {
    const app = createTestApp();
    const res = await app.request('/not-found-custom');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Custom not found' });
  });

  it('returns 400 with details for ValidationError', async () => {
    const app = createTestApp();
    const res = await app.request('/validation');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Bad input', details: { field: 'name' } });
  });

  it('returns 409 for ConflictError', async () => {
    const app = createTestApp();
    const res = await app.request('/conflict');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'Already exists' });
  });

  it('returns 500 with generic message for unhandled errors', async () => {
    const app = createTestApp();
    const res = await app.request('/generic');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });

  it('includes details for AppError when provided', async () => {
    const app = createTestApp();
    const res = await app.request('/app-error');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unprocessable', details: { reason: 'test' } });
  });
});
