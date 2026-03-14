import { Hono } from 'hono';
import { invalidate } from '../services/query-engine';
import { NOTIFY_SESSION_MESSAGE, NOTIFY_SESSION_STATUS, NOTIFY_SESSION_UPDATED, SIDECAR_NOTIFY_EVENTS, type QueryResource, type SidecarNotifyEvent } from '../../../shared/events';

const app = new Hono();

/**
 * POST /notify
 *
 * Receives batched notifications from the sidecar after DB writes.
 * Triggers instant query-engine invalidation for connected clients.
 *
 * Notification events:
 * - session:message  → invalidate messages
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

  // Map sidecar events → query resources for push-first invalidation
  const INVALIDATION_MAP: Record<SidecarNotifyEvent, QueryResource[]> = {
    [NOTIFY_SESSION_MESSAGE]: ['messages'],
    [NOTIFY_SESSION_STATUS]:  ['workspaces', 'sessions', 'stats'],
    [NOTIFY_SESSION_UPDATED]: ['workspaces', 'sessions'],
  };
  const resourcesToInvalidate = new Set<QueryResource>();

  for (const n of notifications) {
    if ((SIDECAR_NOTIFY_EVENTS as readonly string[]).includes(n.event)) {
      const resources = INVALIDATION_MAP[n.event as SidecarNotifyEvent];
      resources.forEach((r) => resourcesToInvalidate.add(r));
    }
  }

  // Push-first invalidation for query subscribers
  if (resourcesToInvalidate.size > 0) {
    invalidate([...resourcesToInvalidate]);
  }

  return c.json({ ok: true });
});

export default app;
