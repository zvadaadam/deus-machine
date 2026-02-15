import { useEffect, useRef } from "react";
import { isTauriEnv } from "@/platform/tauri";

/**
 * Detects active window resize and toggles `.window-resizing` class on <html>.
 *
 * WKWebView pauses rendering during native window transitions (fullscreen exit,
 * window snapping, drag resize). CSS transitions fighting the native animation
 * cause content to appear "stuck" at the old size. This hook disables layout
 * transitions during the resize window so the webview content can reflow instantly
 * once WebKit unpauses rendering.
 *
 * Uses the same class-on-html pattern as useIsFullscreen (.fullscreen).
 */
const DEBOUNCE_MS = 150;

export function useWindowResizing(): void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!isTauriEnv) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        unlisten = await getCurrentWindow().onResized(() => {
          document.documentElement.classList.add("window-resizing");
          clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => {
            document.documentElement.classList.remove("window-resizing");
          }, DEBOUNCE_MS);
        });
        // If unmount happened while awaiting onResized, clean up immediately
        if (cancelled) unlisten();
      } catch {
        // Not in Tauri environment
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      clearTimeout(timeoutRef.current);
      document.documentElement.classList.remove("window-resizing");
    };
  }, []);
}
