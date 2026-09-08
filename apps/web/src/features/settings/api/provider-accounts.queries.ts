import { useQuery } from "@tanstack/react-query";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { listProviderAccounts } from "./provider-accounts.service";

export const PROVIDER_ACCOUNTS_QUERY_KEY = ["settings", "provider-accounts"] as const;

export function providerAccountsQueryOptions(accountId: string | null | undefined) {
  return {
    queryKey: [...PROVIDER_ACCOUNTS_QUERY_KEY, accountId ?? null],
    queryFn: ({ signal }: { signal: AbortSignal }) => listProviderAccounts(signal),
    enabled: Boolean(accountId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  };
}

export function useProviderAccounts() {
  const session = useDeusCloudSession();
  const accountId = session.data?.signedIn ? session.data.accountId : null;
  return { accountId, ...useQuery(providerAccountsQueryOptions(accountId)) };
}
