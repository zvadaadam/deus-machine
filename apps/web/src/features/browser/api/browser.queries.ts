/**
 * Browser-feature TanStack Query hooks.
 *
 * Currently just `useLocalServers()` — subscribes to the backend's
 * `localServers` resource (curated-port HTTP probe) and returns the
 * snapshot. Single global cache; not workspace-scoped because the
 * probe is a property of the host machine, not the active workspace.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { call } from "@/platform/ws";
import type { LocalServersSnapshot } from "@shared/types";

const EMPTY_SNAPSHOT: LocalServersSnapshot = {
  servers: [],
  isLoading: false,
  refreshedAt: null,
};

const QUERY_KEY = ["browser", "local-servers"] as const;

export function useLocalServers(): {
  data: LocalServersSnapshot;
  isLoading: boolean;
} {
  useQuerySubscription(api.localServers, { queryKey: QUERY_KEY });

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => call(api.localServers),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data ?? EMPTY_SNAPSHOT,
    isLoading: query.isLoading,
  };
}
