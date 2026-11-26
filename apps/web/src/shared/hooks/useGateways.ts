import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "./useQuerySubscription";

const queryKey = ["gateways"] as const;

export function useGateways(enabled = true) {
  useQuerySubscription(api.gateways, { queryKey, enabled });
  return useQuery({
    queryKey,
    queryFn: () => call(api.gateways),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
