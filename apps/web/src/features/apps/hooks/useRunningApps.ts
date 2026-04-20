/**
 * Running app instances scoped to a workspace.
 *
 * When `workspaceId` is null (no workspace selected) the hook returns an empty
 * list without subscribing — callers don't need to gate.
 */

import { useQuery } from "@tanstack/react-query";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { sendRequest } from "@/platform/ws/query-protocol-client";
import type { RunningApp } from "@shared/aap/types";

const EMPTY: RunningApp[] = [];

export function useRunningApps(workspaceId: string | null): {
  data: RunningApp[];
  isLoading: boolean;
} {
  // Passing workspaceId in the queryKey isolates caches per workspace so
  // a switch swaps data instantly rather than showing stale rows while the
  // subscription rebinds.
  const queryKey = ["aap", "running-apps", workspaceId ?? "__none"] as const;

  useQuerySubscription("running_apps", {
    queryKey,
    params: workspaceId ? { workspaceId } : {},
    enabled: !!workspaceId,
  });

  const query = useQuery({
    queryKey,
    queryFn: () => sendRequest<RunningApp[]>("running_apps", workspaceId ? { workspaceId } : {}),
    enabled: !!workspaceId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return {
    data: workspaceId ? (query.data ?? EMPTY) : EMPTY,
    isLoading: !!workspaceId && query.isLoading,
  };
}
