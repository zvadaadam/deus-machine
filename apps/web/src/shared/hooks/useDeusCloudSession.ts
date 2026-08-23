import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { getSession, onAuthChanged } from "@/platform/native/deus-cloud";

/**
 * The Deus Cloud session, one way. Four surfaces declared this query
 * inline and drifted apart — the copies that dropped a branch were where
 * the "tells the user the wrong thing" bugs kept landing.
 *
 * The auth-changed listener lives HERE, not in AccountSection: the
 * background device-key mint finishes after login resolves and announces
 * itself via broadcast, and a listener owned by one section dies when the
 * user navigates to another. Any mounted consumer keeps it alive; the
 * duplicate subscriptions are idempotent writes.
 */
export function useDeusCloudSession() {
  const queryClient = useQueryClient();
  useEffect(() => {
    return onAuthChanged((nextSession) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, nextSession);
      // Everything derived from the account changes with it: the backend's
      // cloud status flips on the credentials push, and the GitHub App
      // state is org-scoped — account B must not inherit A's installations
      // for the cache's freshness window.
      void queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
      void queryClient.invalidateQueries({ queryKey: ["settings", "github-app"] });
    });
  }, [queryClient]);

  return useQuery({
    queryKey: queryKeys.deusCloud.session,
    queryFn: getSession,
    staleTime: 30_000,
    retry: false,
  });
}
