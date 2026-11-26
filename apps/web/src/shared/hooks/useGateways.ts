import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "./useQuerySubscription";
import { queryKeys } from "@/shared/api/queryKeys";

export function useGateways(enabled = true) {
  const queryKey = queryKeys.settings.gateways;
  useQuerySubscription(api.gateways, { queryKey, enabled });
  return useQuery({
    queryKey,
    queryFn: () => call(api.gateways),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
