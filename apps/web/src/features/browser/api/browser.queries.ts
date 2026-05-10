/**
 * Browser-feature TanStack Query hooks.
 *
 * Currently just `useLocalServers()` — subscribes to the backend's
 * `local_servers` resource (curated-port HTTP probe) and returns the
 * snapshot. Single global cache; not workspace-scoped because the
 * probe is a property of the host machine, not the active workspace.
 */

import { useQuery } from "@tanstack/react-query";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { sendRequest } from "@/platform/ws/query-protocol-client";
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
  useQuerySubscription("local_servers", { queryKey: QUERY_KEY });

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => sendRequest<LocalServersSnapshot>("local_servers", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data ?? EMPTY_SNAPSHOT,
    isLoading: query.isLoading,
  };
}
