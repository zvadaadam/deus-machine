import { Hono } from 'hono';
import { triggerWatcherTick } from '../services/relay.service';
import { invalidate } from '../services/query-engine';
import { NOTIFY_SESSION_MESSAGE, NOTIFY_SESSION_STATUS, NOTIFY_SESSION_UPDATED, SIDECAR_NOTIFY_EVENTS, type QueryResource, type SidecarNotifyEvent } from '../../../shared/events';

const app = new Hono();

/**
 * POST /notify
 *
 * Receives batched notifications from the sidecar after DB writes.
 * Triggers instant dashboard updates instead of waiting for polling.
 *
 * Notification events:
 * - session:message  → trigger watcher tick (pushes message deltas to watching clients)
 * - session:status   → invalidate workspaces, sessions, stats
 * - session:updated  → invalidate workspaces, sessions
 */
app.post('/notify', async (c) => {
  const { notifications } = await c.req.json<{
    notifications: Array<{ event: string; sessionId?: string }>;
  }>();

  if (!Array.isArray(notifications) || notifications.length === 0) {
    return c.json({ ok: true });
  }

  let needsWatcherTick = false;

  // Map sidecar events → query resources for push-first invalidation
  const INVALIDATION_MAP: Record<SidecarNotifyEvent, QueryResource[]> = {
    [NOTIFY_SESSION_MESSAGE]: ['messages'],
    [NOTIFY_SESSION_STATUS]:  ['workspaces', 'sessions', 'stats'],
    [NOTIFY_SESSION_UPDATED]: ['workspaces', 'sessions'],
  };
  const resourcesToInvalidate = new Set<QueryResource>();

  for (const n of notifications) {
    if (n.event === NOTIFY_SESSION_MESSAGE) {
      needsWatcherTick = true;
    }
    if ((SIDECAR_NOTIFY_EVENTS as readonly string[]).includes(n.event)) {
      const resources = INVALIDATION_MAP[n.event as SidecarNotifyEvent];
      resources.forEach((r) => resourcesToInvalidate.add(r));
    }
  }

  // Trigger watcher immediately so watching clients get message deltas
  if (needsWatcherTick) {
    triggerWatcherTick();
  }

  // Push-first invalidation for query subscribers
  if (resourcesToInvalidate.size > 0) {
    invalidate([...resourcesToInvalidate]);
  }

  return c.json({ ok: true });
});

export default app;
