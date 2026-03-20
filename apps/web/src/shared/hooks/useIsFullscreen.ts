import { useState, useEffect, useCallback } from "react";
import { capabilities } from "@/platform/capabilities";

/**
 * Tracks Electron window fullscreen state and toggles a `.fullscreen` class on
 * `<html>`, mirroring the existing `.electron` class pattern from main.tsx.
 *
 * macOS hides traffic lights in fullscreen, so CSS uses
 * `.electron:not(.fullscreen)` to conditionally apply titlebar clearance padding.
 *
 * Uses the preload bridge's `onFullscreenChange` listener (main process sends
 * events on enter-full-screen / leave-full-screen).
 */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const check = useCallback(async () => {
    if (!capabilities.nativeWindowChrome) return;
    try {
      const fs = await window.electronAPI!.isFullscreen();
      setIsFullscreen(fs);
      document.documentElement.classList.toggle("fullscreen", fs);
    } catch {
      // API not available
    }
  }, []);

  useEffect(() => {
    if (!capabilities.nativeWindowChrome) return;

    check();

    // Listen for fullscreen changes from the main process
    const unlisten = window.electronAPI!.onFullscreenChange(({ isFullscreen: fs }) => {
      setIsFullscreen(fs);
      document.documentElement.classList.toggle("fullscreen", fs);
    });

    return () => {
      unlisten();
      document.documentElement.classList.remove("fullscreen");
    };
  }, [check]);

  return isFullscreen;
}
