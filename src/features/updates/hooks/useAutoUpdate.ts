/**
 * Auto-update hook for Tauri desktop app.
 *
 * Mirrors Conductor/Chorus pattern:
 * - Check on launch + every 5 minutes
 * - Auto-download silently in background
 * - Deduplicate via localStorage
 * - Race-protect concurrent downloads via useRef
 * - Skip in DEV mode and non-Tauri environments
 */
import { useState, useEffect, useRef, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauriEnv } from "@/platform/tauri";

export type UpdateStage = "idle" | "checking" | "downloading" | "ready" | "error";

export interface UpdateState {
  stage: UpdateStage;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

export interface UseAutoUpdateReturn {
  state: UpdateState;
  /** Manually trigger an update check (for Settings button). */
  check: () => Promise<void>;
  /** Install the downloaded update and restart the app. */
  install: () => Promise<void>;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_VERSION_KEY = "pendingUpdateVersion";

export function useAutoUpdate(): UseAutoUpdateReturn {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const updateRef = useRef<Update | null>(null);
  const isDownloadingRef = useRef(false);

  // Clear pending version on mount — if we're running, the previous update was applied
  useEffect(() => {
    localStorage.removeItem(PENDING_VERSION_KEY);
  }, []);

  const downloadUpdate = useCallback(async (update: Update) => {
    if (isDownloadingRef.current) return;
    isDownloadingRef.current = true;
    setState((prev) => ({ ...prev, stage: "downloading" }));

    try {
      await update.downloadAndInstall();
      isDownloadingRef.current = false;
      localStorage.setItem(PENDING_VERSION_KEY, update.version);
      setState({
        stage: "ready",
        version: update.version,
        releaseNotes: update.body ?? undefined,
      });
    } catch (err) {
      isDownloadingRef.current = false;
      setState({
        stage: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const check = useCallback(async () => {
    if (!isTauriEnv) return;

    setState((prev) => ({ ...prev, stage: "checking" }));

    try {
      // Dynamic import so the module isn't loaded in web-only mode
      const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
      const update = await checkUpdate();

      if (!update) {
        setState({ stage: "idle" });
        return;
      }

      updateRef.current = update;

      // Skip re-download if we already staged this version
      const pendingVersion = localStorage.getItem(PENDING_VERSION_KEY);
      if (pendingVersion === update.version) {
        setState({
          stage: "ready",
          version: update.version,
          releaseNotes: update.body ?? undefined,
        });
        return;
      }

      // Auto-download silently
      await downloadUpdate(update);
    } catch (err) {
      setState({
        stage: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [downloadUpdate]);

  const install = useCallback(async () => {
    if (!isTauriEnv) return;
    try {
      localStorage.removeItem(PENDING_VERSION_KEY);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("Failed to relaunch:", err);
    }
  }, []);

  // Auto-check on mount + interval (skip in DEV and non-Tauri)
  useEffect(() => {
    if (!isTauriEnv || import.meta.env.DEV) return;

    // Initial check
    void check().catch(console.error);

    // Periodic checks
    const interval = setInterval(() => {
      void check().catch(console.error);
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [check]);

  return { state, check, install };
}
