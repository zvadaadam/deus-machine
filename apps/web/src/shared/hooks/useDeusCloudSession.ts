import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { getSession, onAuthChanged } from "@/platform/native/deus-cloud";
import type { DeusCloudSessionStatus } from "@shared/types";

/**
 * Apply an account change to EVERY account-scoped cache — one implementation
 * for both triggers: the desktop's auth-changed broadcast (the listener below)
 * and the web sign-out mutation, whose browser `onAuthChanged` is a no-op, so
 * without this a signed-out web user kept a live direct token + agnt socket
 * until the token expired.
 */
export function applyDeusCloudAuthChange(
  queryClient: QueryClient,
  nextSession: DeusCloudSessionStatus
): void {
  queryClient.setQueryData(queryKeys.deusCloud.session, nextSession);
  // EVERY account-scoped cache, and RESET rather than invalidate — invalidate
  // keeps the old account's data rendering while the refetch runs, and with
  // `retry: false` a failed refetch strands it indefinitely. The curated-subset
  // + invalidate combination is how account B kept seeing A's data, four
  // separate times on this branch. Concretely:
  //  - settings/* + repo-cloud-environment: A's subscriptions and environments.
  //  - workspaces + sessions (detail, by-workspace, messages): in web-direct
  //    these are A's repo names and TRANSCRIPTS, cached with staleTime
  //    Infinity; on desktop the mixed list carries A's cloud rows (the local
  //    rows refetch from the Mac backend in the same beat).
  //  - cloudRepoAccess GATES the create action (B must not reuse A's "ok").
  //  - cloudDirectToken is an account-scoped JWT driving a live agnt socket —
  //    dropping the data tears the socket down (useCloudDirect passes null
  //    params once it's gone).
  for (const key of [
    ["settings", "cloud"],
    ["settings", "github-app"],
    ["settings", "claude-subscription"],
    ["settings", "codex-subscription"],
    ["settings", "cloud-environments"],
    ["repo-cloud-environment"],
    ["workspaces"],
    ["sessions"],
    ["cloudRepoAccess"],
    ["cloudDirectToken"],
  ]) {
    void queryClient.resetQueries({ queryKey: key });
  }
}

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
    return onAuthChanged((nextSession) => applyDeusCloudAuthChange(queryClient, nextSession));
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
