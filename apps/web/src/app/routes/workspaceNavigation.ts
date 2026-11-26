import type { HistoryLocation, RegisteredRouter } from "@tanstack/react-router";

// TanStack gives each push, replace and pop a new location object, even for the same URL.
const selectionWrites = new WeakSet<HistoryLocation>();

export function writeWorkspaceSelection(router: RegisteredRouter, href: string, replace = false) {
  if (router.history.location.href === href) return;
  const unsubscribe = router.history.subscribe(({ location, action }) => {
    if (location.href === href && action.type === (replace ? "REPLACE" : "PUSH")) {
      selectionWrites.add(location);
    }
    unsubscribe();
  });
  void router.navigate({ href, replace }).finally(unsubscribe);
}

export function isWorkspaceSelectionWrite(visit: HistoryLocation): boolean {
  return selectionWrites.has(visit);
}
