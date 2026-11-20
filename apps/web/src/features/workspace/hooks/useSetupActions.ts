import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { useRetrySetup } from "../api/workspace.queries";

/** The header and the transcript act on the workspace that owns the failed setup. */
export function useSetupActions(workspaceId: string | null) {
  const { mutate } = useRetrySetup();
  const retry = useCallback(() => {
    if (workspaceId) mutate(workspaceId, { onError: (error) => toast.error(error.message) });
  }, [workspaceId, mutate]);
  const viewLog = useCallback(() => {
    if (!workspaceId) return;
    call(api.setupLogs, { workspaceId })
      .then(({ logs }) => {
        if (!logs) {
          toast.error("No setup logs available.");
          return;
        }
        const url = URL.createObjectURL(new Blob([logs], { type: "text/plain" }));
        window.open(url, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => toast.error("Failed to fetch setup logs."));
  }, [workspaceId]);
  return { retry, viewLog };
}
