import { useState, useEffect, useCallback } from "react";
import { isTauriEnv } from "@/platform/tauri";

/** macOS updates fullscreen state slightly after the resize event fires;
 *  this delay lets the animation settle before we re-poll. */
const FULLSCREEN_SETTLE_MS = 80;

/**
 * Tracks Tauri window fullscreen state and toggles a `.fullscreen` class on
 * `<html>`, mirroring the existing `.tauri` class pattern from main.tsx.
 *
 * macOS hides traffic lights in fullscreen, so CSS uses
 * `.tauri:not(.fullscreen)` to conditionally apply titlebar clearance padding.
 *
 * There is no dedicated fullscreen event in Tauri v2 — we listen to
 * `onResized` (fires on fullscreen transitions) and poll `isFullscreen()`.
 */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const check = useCallback(async () => {
    if (!isTauriEnv) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const fs = await getCurrentWindow().isFullscreen();
      setIsFullscreen(fs);
      document.documentElement.classList.toggle("fullscreen", fs);
    } catch {
      // Tauri API not available (web dev mode)
    }
  }, []);

  useEffect(() => {
    if (!isTauriEnv) return;

    check();

    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        unlisten = await getCurrentWindow().onResized(() => {
          setTimeout(check, FULLSCREEN_SETTLE_MS);
        });
      } catch {
        // Not in Tauri environment
      }
    })();

    return () => {
      unlisten?.();
      document.documentElement.classList.remove("fullscreen");
    };
  }, [check]);

  return isFullscreen;
}
