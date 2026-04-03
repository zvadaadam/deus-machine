/**
 * Shows a persistent Sonner toast when an update is ready to install.
 * Never auto-dismiss, "Restart" button.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { UseAutoUpdateReturn } from "./useAutoUpdate";

const TOAST_ID = "update-ready";
const RELEASES_URL = "https://github.com/zvadaadam/deus-machine/releases";

export function useUpdateToast({ state, install }: UseAutoUpdateReturn) {
  const shownForVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (state.stage !== "ready" || !state.version) return;

    // Don't re-show toast for the same version
    if (shownForVersionRef.current === state.version) return;
    shownForVersionRef.current = state.version;

    toast(`Update v${state.version} available`, {
      id: TOAST_ID,
      description: "Restart to use the latest version.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Restart",
        onClick: () => void install(),
      },
      cancel: {
        label: "See changes",
        onClick: () => window.open(RELEASES_URL, "_blank"),
      },
    });
  }, [state.stage, state.version, install]);
}
