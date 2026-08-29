/**
 * useCloudRepoAccess — can a cloud sandbox clone this repo right now?
 *
 * One `q:` round-trip to the backend's authoritative resolver (App mint +
 * public probe) — the SAME verdict provisioning uses, so the composer's
 * proactive "Grant repository access" modal can never disagree with what
 * create decides. It's a `q:` request (not the desktop-only GitHub-App-status
 * IPC that Settings reads) because that's the more correct home for the verdict
 * — DRY with provisioning, and ready for when cloud reaches the web. Today the
 * cloud flow (sign-in, and the App-install action in the modal) is desktop-only,
 * so in practice the gate only opens in the desktop app.
 *
 * `watch` (true while the grant modal is open) polls so that returning from the
 * GitHub install page flips the verdict to "ok" and the gate can continue into
 * cloud on its own, with no manual retry.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { sendRequest } from "@/platform/ws";
import type { CloudRepoAccess } from "@shared/types/cloud-access";

export function useCloudRepoAccess(
  repoId: string | null | undefined,
  opts: { enabled?: boolean; watch?: boolean } = {}
): UseQueryResult<CloudRepoAccess> {
  const { enabled = true, watch = false } = opts;
  return useQuery({
    queryKey: ["cloudRepoAccess", repoId],
    queryFn: () => sendRequest<CloudRepoAccess>("cloudRepoAccess", { repoId: repoId! }),
    enabled: enabled && !!repoId,
    // A mint + a probe — cache a few minutes so browsing repos doesn't re-mint,
    // but poll while the grant modal is open to catch the just-granted access.
    staleTime: 5 * 60 * 1000,
    refetchInterval: watch ? 2500 : false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
