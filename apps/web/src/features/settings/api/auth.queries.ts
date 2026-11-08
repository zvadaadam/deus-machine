// TanStack Query hooks for remote access auth endpoints.

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import { AuthService } from "./auth.service";

const authKeys = {
  devices: ["auth", "devices"] as const,
  relayStatus: ["auth", "relay-status"] as const,
};

/** Paired devices, read again whenever the backend says one was added, connected, left or revoked. */
export function usePairedDevices(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return onEvent((event) => {
      if (event === "devices:changed")
        void queryClient.invalidateQueries({ queryKey: authKeys.devices });
    });
  }, [enabled, queryClient]);
  return useQuery({
    queryKey: authKeys.devices,
    queryFn: () => AuthService.listDevices().then((r) => r.devices),
    enabled,
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
