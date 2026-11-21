import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";

/** The header and the transcript act on the workspace that owns the failed setup. */
export function useSetupActions(workspaceId: string) {
  const client = useQueryClient();
  const mutationKey = [api.retrySetup.name, workspaceId];
  const retrying = useIsMutating({ mutationKey }) > 0;
  const { mutateAsync } = useMutation({
    mutationKey,
    mutationFn: () => call(api.retrySetup, { workspaceId }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
  function retry() {
    // The other button can be pressed before either has rendered disabled.
    if (client.isMutating({ mutationKey })) return;
    void mutateAsync().catch((error) => toast.error(getErrorMessage(error)));
  }
  return { workspaceId, retry, retrying };
}
