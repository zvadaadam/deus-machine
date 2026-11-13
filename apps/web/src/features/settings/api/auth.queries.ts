// TanStack Query hooks for remote access: paired devices and the relay tunnel.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { apiClient } from "@/shared/api/client";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

const authKeys = {
  devices: ["auth", "devices"] as const,
  relayStatus: ["auth", "relay-status"] as const,
};

/** Paired devices, kept current: the host sends the list again whenever one is added,
 *  connects, leaves or is revoked. */
export function usePairedDevices(enabled: boolean) {
  useQuerySubscription(api.pairedDevices, { queryKey: authKeys.devices, enabled });
  return useQuery({
    queryKey: authKeys.devices,
    queryFn: () => call(api.pairedDevices),
    select: (answer) => answer.devices,
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Generate a new connection code (mutation). Plain HTTP on purpose: the route
 * is localhost-only, so it is this computer that hands out codes, and it is not
 * an operation a paired device could call.
 */
export function useGeneratePairCode() {
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ code: string; expires_in_seconds: number }>(
        "/remote-auth/generate-pair-code"
      ),
  });
}

/** Remove a connected device. Invalidates the device list on success. */
export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => call(api.revokeDevice, { deviceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.devices });
    },
  });
}

/** Fetch relay connection status. Polls every 5s when enabled. */
export function useRelayStatus(enabled: boolean) {
  return useQuery({
    queryKey: authKeys.relayStatus,
    queryFn: () => call(api.relayStatus),
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 3_000,
  });
}
