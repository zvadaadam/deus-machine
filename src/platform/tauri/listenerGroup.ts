/**
 * Creates a managed group of Tauri event listeners with React Strict Mode
 * race condition protection. Call register() for each listener, then
 * cleanup() in the useEffect return.
 *
 * Why: Tauri's listen() returns a Promise<UnlistenFn>. In React Strict Mode,
 * mount → cleanup → mount happens rapidly. Without the cancelled flag, the
 * first mount's promise resolves after cleanup and registers a listener
 * that never gets cleaned up.
 */
export function createListenerGroup() {
  let cancelled = false;
  const unlistenFns: Array<() => void> = [];

  return {
    register(promise: Promise<() => void>) {
      promise
        .then((fn) => {
          if (cancelled) {
            fn();
            return;
          }
          unlistenFns.push(fn);
        })
        .catch(() => {
          // listen() can reject if Tauri runtime is torn down during navigation
        });
    },
    cleanup() {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    },
  };
}
