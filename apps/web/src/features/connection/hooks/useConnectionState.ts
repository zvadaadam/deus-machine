/**
 * Facade hook over the connection Zustand store.
 *
 * Only exposes fields that UI consumers actually use.
 * `disconnectedAt` and `markSendAttemptFailed` are internal —
 * used only by useConnectionStateInit via getState().
 */

import { useConnectionStore, type ConnectionState } from "../store/connectionStore";

export { type ConnectionState };

export function useConnectionState() {
  const state = useConnectionStore((s) => s.state);
  const sendAttemptFailed = useConnectionStore((s) => s.sendAttemptFailed);
  const retry = useConnectionStore((s) => s.retry);

  return { state, sendAttemptFailed, retry };
}
