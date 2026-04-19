/**
 * Installed apps registry — global (not workspace-scoped).
 *
 * Data flows in via WebSocket:
 *   q:subscribe "apps" → q:snapshot on subscribe, q:snapshot on every invalidate
 * The HTTP queryFn (sendRequest) is a fallback for initial load before WS
 * connects. Pattern mirrors useWorkspacesByRepo — staleTime Infinity leaves
 * freshness to the subscription.
 */

import { useQuery } from "@tanstack/react-query";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { sendRequest } from "@/platform/ws/query-protocol-client";
import type { InstalledApp } from "@shared/aap/types";

const APPS_QUERY_KEY = ["aap", "installed-apps"] as const;

export function useInstalledApps(): {
  data: InstalledApp[] | undefined;
  isLoading: boolean;
} {
  useQuerySubscription("apps", {
    queryKey: APPS_QUERY_KEY,
    params: {},
  });

  const query = useQuery({
    queryKey: APPS_QUERY_KEY,
    queryFn: () => sendRequest<InstalledApp[]>("apps", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return { data: query.data, isLoading: query.isLoading };
}
