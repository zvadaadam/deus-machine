import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockInvalidate = vi.fn();
const mockTriggerWatcherTick = vi.fn();

vi.mock('../../../src/services/query-engine', () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

vi.mock('../../../src/services/relay.service', () => ({
  triggerWatcherTick: () => mockTriggerWatcherTick(),
}));

import app from '../../../src/routes/notify';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /notify', () => {
  const post = (body: unknown) =>
    app.request('/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns ok for empty notifications', async () => {
    const res = await post({ notifications: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockTriggerWatcherTick).not.toHaveBeenCalled();
  });

  it('triggers watcher tick for session:message', async () => {
    const res = await post({
      notifications: [{ event: 'session:message', sessionId: 's-1' }],
    });
    expect(res.status).toBe(200);
    expect(mockTriggerWatcherTick).toHaveBeenCalledTimes(1);
  });

  it('invalidates messages for session:message', async () => {
    await post({
      notifications: [{ event: 'session:message', sessionId: 's-1' }],
    });
    expect(mockInvalidate).toHaveBeenCalledWith(
      expect.arrayContaining(['messages']),
    );
  });

  it('invalidates workspaces, sessions, stats for session:status', async () => {
    await post({
      notifications: [{ event: 'session:status', sessionId: 's-1' }],
    });
    const resources = mockInvalidate.mock.calls[0][0] as string[];
    expect(resources).toContain('workspaces');
    expect(resources).toContain('sessions');
    expect(resources).toContain('stats');
    expect(mockTriggerWatcherTick).not.toHaveBeenCalled();
  });

  it('invalidates workspaces, sessions for session:updated', async () => {
    await post({
      notifications: [{ event: 'session:updated', sessionId: 's-1' }],
    });
    const resources = mockInvalidate.mock.calls[0][0] as string[];
    expect(resources).toContain('workspaces');
    expect(resources).toContain('sessions');
    expect(resources).not.toContain('stats');
  });

  it('deduplicates resources across multiple notifications', async () => {
    await post({
      notifications: [
        { event: 'session:status', sessionId: 's-1' },
        { event: 'session:updated', sessionId: 's-1' },
      ],
    });
    // Both events include 'workspaces' and 'sessions', but invalidate
    // should be called once with deduplicated resources
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    const resources = mockInvalidate.mock.calls[0][0] as string[];
    // Set deduplication means no duplicates
    const unique = [...new Set(resources)];
    expect(resources).toHaveLength(unique.length);
  });

  it('ignores unknown event names without crashing', async () => {
    const res = await post({
      notifications: [{ event: 'unknown:event' }],
    });
    expect(res.status).toBe(200);
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockTriggerWatcherTick).not.toHaveBeenCalled();
  });

  it('handles mixed known and unknown events', async () => {
    await post({
      notifications: [
        { event: 'unknown:event' },
        { event: 'session:message', sessionId: 's-1' },
        { event: 'bogus' },
      ],
    });
    expect(mockTriggerWatcherTick).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockInvalidate.mock.calls[0][0]).toContain('messages');
  });
});
