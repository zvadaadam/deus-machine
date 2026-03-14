// Frontend API service for remote access auth endpoints.

import { apiClient } from "@/shared/api/client";

export interface PairedDevice {
  id: string;
  name: string;
  ip_address: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
}

export interface PairCodeResponse {
  code: string;
  expires_in_seconds: number;
}

export const AuthService = {
  generatePairCode: (): Promise<PairCodeResponse> =>
    apiClient.post<PairCodeResponse>("/remote-auth/generate-pair-code"),

  listDevices: (): Promise<{ devices: PairedDevice[] }> =>
    apiClient.get<{ devices: PairedDevice[] }>("/remote-auth/devices"),

  revokeDevice: (id: string): Promise<{ success: boolean }> =>
    apiClient.delete<{ success: boolean }>(`/remote-auth/devices/${id}`),

  getRelayStatus: (): Promise<RelayStatus> => apiClient.get<RelayStatus>("/relay/status"),
};

export interface RelayStatus {
  connected: boolean;
  clients: number;
  serverId: string | null;
  relayUrl: string | null;
}
