import { useSyncExternalStore } from "react";

/**
 * Whether the document is on screen at all — the window not minimized, the
 * page not in a background tab. An in-app tab switch already unmounts the
 * device stream; this covers the cases the app cannot see from inside:
 * a device nobody is looking at must not have its idle clock reset.
 */
function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, isDocumentVisible, () => true);
}
