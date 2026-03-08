import { Hono } from 'hono';
import { triggerWatcherTick } from '../services/relay.service';
import { broadcastWorkspacesAndStats } from '../services/dashboard-broadcast';
import { invalidate } from '../services/query-engine';

const app = new Hono();

/**
 * POST /notify
 *
 * Receives batched notifications from the sidecar after DB writes.
 * Triggers instant dashboard updates instead of waiting for polling.
 *
 * Notification events:
 * - session:message  → trigger watcher tick (pushes message deltas to watching clients)
 * - session:status   → broadcast workspace list + stats snapshot
 * - session:updated  → broadcast workspace list + stats snapshot
 */
app.post('/notify', async (c) => {
  const { notifications } = await c.req.json<{
    notifications: Array<{ event: string; sessionId?: string }>;
  }>();

  if (!Array.isArray(notifications) || notifications.length === 0) {
    return c.json({ ok: true });
  }

  let needsWatcherTick = false;
  let needsBroadcast = false;

  // Map sidecar events → query resources for push-first invalidation
  const INVALIDATION_MAP: Record<string, string[]> = {
    'session:message': ['messages'],
    'session:status':  ['workspaces', 'sessions', 'stats'],
    'session:updated': ['workspaces', 'sessions'],
  };
  const resourcesToInvalidate = new Set<string>();

  for (const n of notifications) {
    if (n.event === 'session:message') {
      needsWatcherTick = true;
    }
    if (n.event === 'session:status' || n.event === 'session:updated') {
      needsBroadcast = true;
    }
    const resources = INVALIDATION_MAP[n.event];
    if (resources) resources.forEach(r => resourcesToInvalidate.add(r));
  }

  // Trigger watcher immediately so watching clients get message deltas
  if (needsWatcherTick) {
    triggerWatcherTick();
  }

  // Broadcast updated workspace list + stats to all connected clients
  if (needsBroadcast) {
    broadcastWorkspacesAndStats();
  }

  // Push-first invalidation for Deus Query subscribers
  if (resourcesToInvalidate.size > 0) {
    invalidate([...resourcesToInvalidate]);
  }

  return c.json({ ok: true });
});

export default app;
