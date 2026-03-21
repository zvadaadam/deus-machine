// Frontend API service for remote access auth endpoints.
// generatePairCode stays as HTTP — it's a pre-auth localhost-only endpoint.

import { apiClient } from "@/shared/api/client";
import { sendRequest, sendMutate } from "@/platform/ws";

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
  // Pre-auth endpoint — must stay as HTTP (no WS connection yet during pairing)
  generatePairCode: (): Promise<PairCodeResponse> =>
    apiClient.post<PairCodeResponse>("/remote-auth/generate-pair-code"),

  listDevices: (): Promise<{ devices: PairedDevice[] }> =>
    sendRequest<{ devices: PairedDevice[] }>("pairedDevices"),

  revokeDevice: async (id: string): Promise<{ success: boolean }> => {
    const result = await sendMutate<{ success: boolean }>("revokeDevice", { deviceId: id });
    if (!result.success) throw new Error(result.error || "Failed to revoke device");
    return result.data ?? { success: true };
  },

  getRelayStatus: (): Promise<RelayStatus> => sendRequest<RelayStatus>("relayStatus"),
};

export interface RelayStatus {
  connected: boolean;
  clients: number;
  serverId: string | null;
  relayUrl: string | null;
}
