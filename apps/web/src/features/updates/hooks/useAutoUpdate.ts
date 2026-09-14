import { useState, useEffect, useCallback } from "react";
import { capabilities } from "@/platform/capabilities";
import { getErrorMessage } from "@shared/lib/errors";
import type { UpdateState } from "@shared/types/updates";

export interface UseAutoUpdateReturn {
  state: UpdateState;
  /** Returns true when the installed version is up to date. */
  check: () => Promise<boolean>;
  install: () => Promise<void>;
}

/** Project Electron's update state; the renderer never owns a download. */
export function useAutoUpdate(): UseAutoUpdateReturn {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });

  useEffect(() => {
    if (!capabilities.autoUpdate) return;
    const api = window.electronAPI!;
    let receivedState = false;
    const unlisten = api.onUpdateState((next) => {
      receivedState = true;
      setState(next);
    });
    // Recover an already-downloaded update when the renderer reloads. A push
    // received during this request is newer than the initial snapshot.
    void api
      .getUpdateState()
      .then((initial) => {
        if (!receivedState) setState(initial);
      })
      .catch((err) => {
        if (!receivedState) setState({ stage: "error", error: getErrorMessage(err) });
      });
    return () => {
      receivedState = true;
      unlisten();
    };
  }, []);

  const check = useCallback(async (): Promise<boolean> => {
    if (!capabilities.autoUpdate) return true;
    try {
      const result = await window.electronAPI!.checkForUpdates();
      if (!result.supported) {
        setState({ stage: "error", error: result.reason });
        return false;
      }
      return !result.available;
    } catch (err) {
      setState({ stage: "error", error: getErrorMessage(err) });
      return false;
    }
  }, []);

  const install = useCallback(async () => {
    if (!capabilities.autoUpdate) return;
    try {
      await window.electronAPI!.installUpdate();
    } catch (err) {
      setState({ stage: "error", error: getErrorMessage(err) });
    }
  }, []);

  return { state, check, install };
}
