import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";

/**
 * Deus Cloud status for the current device — one canonical shape for the one
 * `/settings/cloud` endpoint. Four surfaces used to declare this query inline
 * and drifted apart (the copies that dropped a field were where the "tells the
 * user the wrong thing" bugs kept landing); this hook owns the key, the type,
 * and the fetch policy so they can't diverge again.
 */
export interface CloudSettings {
  enabled: boolean;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  hasGithubToken: boolean;
  hasTurnCredential?: boolean;
  hasClaudeTurnCredential?: boolean;
  hasPlatformCodex?: boolean;
}

export const CLOUD_SETTINGS_QUERY_KEY = ["settings", "cloud"] as const;

export function useCloudSettings() {
  return useQuery({
    queryKey: CLOUD_SETTINGS_QUERY_KEY,
    queryFn: () => apiClient.get<CloudSettings>("/settings/cloud"),
    staleTime: 30_000,
    retry: false,
  });
}
