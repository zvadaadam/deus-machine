// TanStack Query hooks for remote access auth endpoints.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AuthService } from "./auth.service";

const authKeys = {
  devices: ["auth", "devices"] as const,
  relayStatus: ["auth", "relay-status"] as const,
};

/** Fetch paired devices. Polls every 10s when enabled. */
export function usePairedDevices(enabled: boolean) {
  return useQuery({
    queryKey: authKeys.devices,
    queryFn: () => AuthService.listDevices().then((r) => r.devices),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
    staleTime: 5_000,
  });
}

/** Generate a new connection code (mutation). */
export function useGeneratePairCode() {
  return useMutation({
    mutationFn: () => AuthService.generatePairCode(),
  });
}

/** Remove a connected device. Invalidates the device list on success. */
export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => AuthService.revokeDevice(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.devices });
    },
  });
}

/** Fetch relay connection status. Polls every 5s when enabled. */
export function useRelayStatus(enabled: boolean) {
  return useQuery({
    queryKey: authKeys.relayStatus,
    queryFn: () => AuthService.getRelayStatus(),
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 3_000,
  });
}
