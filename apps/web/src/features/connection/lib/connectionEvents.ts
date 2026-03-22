/**
 * Tiny event emitter for cross-feature connection signals.
 *
 * Session actions call emitSendAttemptFailed() when a command rejects
 * because the WebSocket is down. The connection store listens and
 * immediately escalates to DISCONNECTED state.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function emitSendAttemptFailed(): void {
  for (const fn of listeners) fn();
}

export function onSendAttemptFailed(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
