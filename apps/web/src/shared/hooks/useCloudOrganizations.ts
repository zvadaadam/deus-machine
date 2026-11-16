import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

/**
 * This backend's cloud (`cloudOrganizations`): whether it can act there, the
 * account's organizations and which are ready on this computer, and the default
 * one. The one way the web app reads it. A backend pushes every change (a sign-in,
 * a sign-out, keys made), so this never asks again; on the hosted web the direct
 * lane answers it from the platform's own list (cloudDataAdapter).
 */
export const CLOUD_ORGANIZATIONS_QUERY_KEY = ["cloudOrganizations"] as const;

export function useCloudOrganizations() {
  useQuerySubscription(api.cloudOrganizations, {
    queryKey: CLOUD_ORGANIZATIONS_QUERY_KEY,
    params: {},
  });
  return useQuery({
    queryKey: CLOUD_ORGANIZATIONS_QUERY_KEY,
    queryFn: () => call(api.cloudOrganizations),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  }).data;
}
