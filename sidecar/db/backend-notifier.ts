// sidecar/db/backend-notifier.ts
// Fire-and-forget HTTP POST to the backend to trigger instant dashboard updates.
// Uses microtask coalescing (Beck's design): multiple writes in the same synchronous
// call stack are batched into a single HTTP POST.

const NOTIFY_URL = process.env.BACKEND_NOTIFY_URL;

// Pending notifications to be sent in the next microtask
let pending: Array<{ event: string; sessionId?: string }> | null = null;

/**
 * Notify the backend that something changed in the DB.
 * Fire-and-forget: never throws, never blocks the write path.
 *
 * Uses queueMicrotask to coalesce rapid-fire writes (e.g., during streaming
 * where 10+ messages/sec arrive) into a single HTTP POST per event loop tick.
 */
export function notifyBackend(event: string, sessionId?: string): void {
  if (!NOTIFY_URL) return;

  if (!pending) {
    pending = [];
    queueMicrotask(flush);
  }
  pending.push({ event, sessionId });
}

function flush(): void {
  const batch = pending;
  pending = null;
  if (!batch || batch.length === 0) return;

  fetch(NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notifications: batch }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // Fire-and-forget: if backend is down, polling fallback handles it
  });
}
