import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";
import { getEnvironmentInstallUrl } from "../../api/environment-secrets.service";

export function ConnectEnvironmentRepositories({
  orgId,
  accountId,
}: {
  orgId: string;
  accountId: string;
}) {
  const install = useQuery({
    queryKey: queryKeys.settings.environments.installation(accountId, orgId),
    queryFn: ({ signal }) => getEnvironmentInstallUrl(orgId, signal),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  if (install.isError)
    return (
      <Button size="sm" variant="outline" onClick={() => void install.refetch()}>
        Retry GitHub connection
      </Button>
    );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!install.data}
      onClick={() => {
        if (install.data) void native.window.openExternal(install.data.url);
      }}
    >
      Install GitHub App
    </Button>
  );
}
