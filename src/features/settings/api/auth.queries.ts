// TanStack Query hooks for remote access auth endpoints.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AuthService } from "./auth.service";

const authKeys = {
  devices: ["auth", "devices"] as const,
  localIp: ["auth", "local-ip"] as const,
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

/** Generate a new pairing code (mutation). */
export function useGeneratePairCode() {
  return useMutation({
    mutationFn: () => AuthService.generatePairCode(),
  });
}

/** Revoke a paired device. Invalidates the device list on success. */
export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => AuthService.revokeDevice(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.devices });
    },
  });
}

/** Fetch the local network IP and server port. */
export function useNetworkInfo(enabled: boolean) {
  return useQuery({
    queryKey: authKeys.localIp,
    queryFn: () => AuthService.getLocalIp(),
    enabled,
    staleTime: 60_000, // IP/port rarely change
  });
}
