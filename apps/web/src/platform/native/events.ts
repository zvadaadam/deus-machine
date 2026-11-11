import { capabilities } from "../capabilities";
import { listen } from "../electron/invoke";
import type { AppEventName, AppEventMap } from "@shared/events";

/**
 * Subscribe to a native IPC event. Returns unsubscribe function.
 * In web mode, returns a no-op unsubscribe.
 *
 * Note: The returned cleanup function is synchronous, but the actual
 * listener registration is async (listen returns Promise<UnlistenFn>).
 * For React effects, call the returned fn in the cleanup. If the
 * listener hasn't resolved yet, it will be cleaned up when it does.
 */
export function on<K extends AppEventName>(
  event: K,
  callback: (data: AppEventMap[K]) => void
): () => void {
  if (!capabilities.ipcEventListeners) return () => {};

  let cleanup: (() => void) | null = null;
  let cancelled = false;

  // listen() returns Promise<UnlistenFn>
  listen(event, (e) => callback(e.payload as AppEventMap[K]))
    .then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    })
    .catch(() => {
      /* Expected: IPC listener registration can fail in web mode or if bridge is unavailable */
    });

  return () => {
    cancelled = true;
    cleanup?.();
  };
}
