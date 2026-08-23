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
      // EVERY account-scoped cache, not a curated subset — the subset is how
      // account B kept seeing A's data for a freshness window, three separate
      // times on this branch.
      for (const key of [
        ["settings", "cloud"],
        ["settings", "github-app"],
        ["settings", "claude-subscription"],
        ["settings", "codex-subscription"],
        ["settings", "cloud-environments"],
        ["repo-cloud-environment"],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    });
  }, [queryClient]);

  return useQuery({
    queryKey: queryKeys.deusCloud.session,
    queryFn: getSession,
    staleTime: 30_000,
    // The heartbeat that keeps a long-idle app signed in: each read runs the
    // main process's session check, which silently refreshes inside the
    // renewal window. Without it — focus-refetch is globally off — an app
    // left open never re-read the session, the token aged out, and GitHub
    // App mints started failing while the UI said signed in.
    refetchInterval: 15 * 60_000,
    retry: false,
  });
}
