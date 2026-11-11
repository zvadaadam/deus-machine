import { useQuery } from "@tanstack/react-query";
import { sendRequest } from "@/platform/ws/query-protocol-client";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import type { CloudModelCatalog } from "@shared/cloud-models";

/**
 * The models Deus Cloud runs, per harness, as the platform lists them — the
 * source for every cloud model picker (a chat's through useModelLists), so
 * none keeps a list of its own that goes stale when the sandbox image moves.
 * The backend reads `listModels()` and caches it a few minutes; this caches
 * it as long.
 *
 * Keyed under ["settings", "cloud"], so an account change resets it with the
 * rest of the account's cloud settings (see cloudAuthCache).
 */
export const CLOUD_MODELS_QUERY_KEY = ["settings", "cloud", "models"] as const;

export function useCloudModels({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: CLOUD_MODELS_QUERY_KEY,
    queryFn: () => sendRequest<CloudModelCatalog>("cloudModels", {}),
    staleTime: 5 * 60_000,
    retry: 1,
    // Web-direct has no Mac backend to ask (and no automations to edit).
    enabled: enabled && !isCloudDirectWebMode(),
  });
}
