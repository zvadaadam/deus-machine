/**
 * Auto-update hook for Electron desktop app.
 *
 * Update pattern:
 * - Check on launch + every 5 minutes
 * - Auto-download silently in background
 * - Deduplicate via localStorage
 * - Race-protect concurrent downloads via useRef
 * - Skip in DEV mode and non-Electron environments
 *
 * Uses the preload bridge (window.electronAPI) for update operations.
 * The main process uses electron-updater to handle the actual update flow.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { isElectronEnv } from "@/platform/electron";
import { getErrorMessage } from "@shared/lib/errors";

export type UpdateStage = "idle" | "checking" | "downloading" | "ready" | "error";

export interface UpdateState {
  stage: UpdateStage;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

export interface UseAutoUpdateReturn {
  state: UpdateState;
  /** Manually trigger an update check. Returns true if no update found (up-to-date). */
  check: () => Promise<boolean>;
  /** Install the downloaded update and restart the app. */
  install: () => Promise<void>;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_VERSION_KEY = "pendingUpdateVersion";

export function useAutoUpdate(): UseAutoUpdateReturn {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const isDownloadingRef = useRef(false);

  // Clear pending version on mount -- if we're running, the previous update was applied
  useEffect(() => {
    localStorage.removeItem(PENDING_VERSION_KEY);
  }, []);

  // Listen for update state changes from the main process
  useEffect(() => {
    if (!isElectronEnv) return;

    const unlisten = window.electronAPI.onUpdateState((updateState: unknown) => {
      const s = updateState as {
        stage: UpdateStage;
        version?: string;
        releaseNotes?: string;
        error?: string;
      };
      if (s.stage === "ready" && s.version) {
        localStorage.setItem(PENDING_VERSION_KEY, s.version);
        isDownloadingRef.current = false;
      }
      if (s.stage === "error") {
        isDownloadingRef.current = false;
      }
      setState(s);
    });

    return () => unlisten();
  }, []);

  const check = useCallback(async (): Promise<boolean> => {
    if (!isElectronEnv) return true;

    setState((prev) => ({ ...prev, stage: "checking" }));

    try {
      const result = (await window.electronAPI.checkForUpdates()) as {
        available: boolean;
        version?: string;
        releaseNotes?: string;
      } | null;

      if (!result || !result.available) {
        setState({ stage: "idle" });
        return true; // No update available -- up to date
      }

      // Skip re-download if we already staged this version
      const pendingVersion = localStorage.getItem(PENDING_VERSION_KEY);
      if (pendingVersion === result.version) {
        setState({
          stage: "ready",
          version: result.version,
          releaseNotes: result.releaseNotes,
        });
        return false;
      }

      // Auto-download silently
      if (!isDownloadingRef.current) {
        isDownloadingRef.current = true;
        setState((prev) => ({ ...prev, stage: "downloading" }));
        await window.electronAPI.downloadUpdate();
      }

      return false;
    } catch (err) {
      setState({
        stage: "error",
        error: getErrorMessage(err),
      });
      return false;
    }
  }, []);

  const install = useCallback(async () => {
    if (!isElectronEnv) return;
    try {
      localStorage.removeItem(PENDING_VERSION_KEY);
      await window.electronAPI.installUpdate();
    } catch (err) {
      console.error("Failed to install update:", err);
    }
  }, []);

  // Auto-check on mount + interval (skip in DEV and non-Electron)
  useEffect(() => {
    if (!isElectronEnv || import.meta.env.DEV) return;

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
