import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { SimulatorCapabilities } from "@shared/types/simulator";
import { call } from "@/platform/ws";

const UNAVAILABLE_CAPABILITIES: SimulatorCapabilities = {
  available: false,
  unavailableReason: "Simulator capability has not been confirmed by the backend.",
};

const SIMULATOR_CAPABILITIES_QUERY_KEY = ["simulator", "capabilities"] as const;

export function useSimulatorCapabilities(options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: SIMULATOR_CAPABILITIES_QUERY_KEY,
    queryFn: () => call(api.simulatorCapabilities),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: options.enabled ?? true,
  });

  return {
    ...query,
    data: query.data ?? UNAVAILABLE_CAPABILITIES,
  };
}
