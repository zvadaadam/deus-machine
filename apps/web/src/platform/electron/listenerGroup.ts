/**
 * Creates a managed group of event listeners with React Strict Mode
 * race condition protection. Call register() for each listener, then
 * cleanup() in the useEffect return.
 *
 * Why: listen() returns a Promise<UnlistenFn>. In React Strict Mode,
 * mount -> cleanup -> mount happens rapidly. Without the cancelled flag,
 * the first mount's promise resolves after cleanup and registers a listener
 * that never gets cleaned up.
 *
 * Note: In Electron, the preload's `on()` returns a sync unsubscribe fn,
 * but our listen() wrapper returns a Promise for API compatibility with
 * the existing codebase. This group pattern handles both cases.
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
          // listen() can reject if runtime is torn down during navigation
        });
    },
    cleanup() {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    },
  };
}
