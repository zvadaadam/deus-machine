import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import type { DeusCloudSessionStatus } from "@shared/types";

/**
 * Apply an account change to EVERY account-scoped cache — one implementation
 * for every trigger: the desktop's auth-changed broadcast, the web sign-out
 * mutation, and the web bearer's PASSIVE expiry (the heartbeat noticing a dead
 * token). Lives outside the hook module so the platform layer (deus-cloud.ts)
 * can call it without a hook→platform→hook import cycle.
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
