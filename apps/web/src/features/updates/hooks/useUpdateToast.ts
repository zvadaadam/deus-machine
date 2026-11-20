import { useEffect } from "react";
import { toast } from "sonner";
import { releaseUrl } from "../releaseUrl";
import type { UseAutoUpdateReturn } from "./useAutoUpdate";

export function useUpdateToast({ state, install }: UseAutoUpdateReturn) {
  const version = state.stage === "ready" ? state.version : undefined;
  const failedVersion = state.stage === "error" ? state.version : undefined;

  useEffect(() => {
    if (!version) return;

    const id = toast(`Update v${version} available`, {
      description: "Restart to use the latest version.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Restart",
        onClick: () => void install(),
      },
      cancel: {
        label: "See changes",
        onClick: () => window.open(releaseUrl(), "_blank"),
      },
    });
    return () => {
      toast.dismiss(id);
    };
  }, [version, install]);

  useEffect(() => {
    if (!failedVersion) return;
    const id = toast.error(`Update v${failedVersion} couldn't be installed`, {
      description: "Download it and install it by hand.",
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      action: {
        label: "Download",
        onClick: () => window.open(releaseUrl(failedVersion), "_blank"),
      },
    });
    return () => {
      toast.dismiss(id);
    };
  }, [failedVersion]);
}
