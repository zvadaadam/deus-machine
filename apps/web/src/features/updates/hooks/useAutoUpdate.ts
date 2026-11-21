import { useState, useEffect, useCallback } from "react";
import { capabilities } from "@/platform/capabilities";
import { getErrorMessage } from "@shared/lib/errors";
import type { UpdateCheckResult, UpdateState } from "@shared/types/updates";

export interface UseAutoUpdateReturn {
  state: UpdateState;
  check: () => Promise<UpdateCheckResult | null>;
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

  const check = useCallback(async () => {
    if (!capabilities.autoUpdate) return null;
    try {
      return await window.electronAPI!.checkForUpdates();
    } catch (err) {
      setState((previous) =>
        previous.stage === "error" ? previous : { stage: "error", error: getErrorMessage(err) }
      );
      return null;
    }
  }, []);

  const install = useCallback(async () => {
    if (!capabilities.autoUpdate) return;
    try {
      await window.electronAPI!.installUpdate();
    } catch (err) {
      setState((previous) =>
        previous.stage === "error"
          ? previous
          : {
              stage: "error",
              error: getErrorMessage(err),
              ...(previous.stage === "ready" && { version: previous.version }),
            }
      );
    }
  }, []);

  return { state, check, install };
}
