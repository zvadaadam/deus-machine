import { useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { native, capabilities } from "@/platform";

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_DEFAULT = 1.0;
const ZOOM_STORAGE_KEY = "app-zoom-level";

function getStoredZoom(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed) && parsed >= ZOOM_MIN && parsed <= ZOOM_MAX) {
        return parsed;
      }
    }
  } catch {
    // localStorage unavailable
  }
  return ZOOM_DEFAULT;
}

const ZOOM_TOAST_ID = "zoom-level";

function showZoomToast(level: number) {
  const pct = Math.round(level * 100);
  toast(`Zoom: ${pct}%`, { id: ZOOM_TOAST_ID, duration: 1200 });
}

async function applyZoom(level: number) {
  try {
    await native.window.setZoom(level);
  } catch (error) {
    console.warn("[Zoom] setZoom failed:", error);
  }

  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, level.toString());
  } catch {
    // localStorage unavailable
  }
}

/** Enables Cmd+=/Cmd+- zoom in/out and Cmd+0 to reset. Persists across sessions. */
export function useZoom() {
  const zoomRef = useRef(getStoredZoom());

  // Restore persisted zoom on mount (Electron only)
  useEffect(() => {
    if (!capabilities.nativeWindowChrome) return;
    applyZoom(zoomRef.current);
  }, []);

  const zoomIn = useCallback(() => {
    const next = Math.min(zoomRef.current + ZOOM_STEP, ZOOM_MAX);
    zoomRef.current = Math.round(next * 10) / 10;
    applyZoom(zoomRef.current);
    showZoomToast(zoomRef.current);
  }, []);

  const zoomOut = useCallback(() => {
    const next = Math.max(zoomRef.current - ZOOM_STEP, ZOOM_MIN);
    zoomRef.current = Math.round(next * 10) / 10;
    applyZoom(zoomRef.current);
    showZoomToast(zoomRef.current);
  }, []);

  const resetZoom = useCallback(() => {
    zoomRef.current = ZOOM_DEFAULT;
    applyZoom(ZOOM_DEFAULT);
    showZoomToast(ZOOM_DEFAULT);
  }, []);

  useEffect(() => {
    // Only intercept zoom shortcuts in Electron; let browser handle its own native zoom
    if (!capabilities.nativeWindowChrome) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, resetZoom]);
}
