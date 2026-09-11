import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { CloudComputeUsage as Usage } from "@shared/types/compute-usage";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/shared/api/queryKeys";
import { listSecretOrganizations } from "../../api/environment-secrets.service";
import { requestCloudSettings } from "../../api/cloud-settings.service";

export function CloudComputeUsage({ accountId }: { accountId: string }) {
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const organizations = useQuery({
    queryKey: queryKeys.settings.environments.organizations(accountId),
    queryFn: ({ signal }) => listSecretOrganizations(signal),
    staleTime: 30_000,
    retry: false,
  });
  const preferredOrg = selectedOrg ?? organizations.data?.currentOrganizationId;
  const orgId =
    organizations.data?.items.find((org) => org.id === preferredOrg)?.id ??
    organizations.data?.items[0]?.id;
  const usage = useQuery({
    queryKey: ["settings", "compute-usage", accountId, orgId],
    queryFn: ({ signal }) =>
      requestCloudSettings<Usage>(
        {
          cloud: `/orgs/${encodeURIComponent(orgId!)}/compute-usage`,
          desktop: `/settings/cloud/compute-usage?organizationId=${encodeURIComponent(orgId!)}`,
        },
        { signal }
      ),
    enabled: !!orgId,
    staleTime: 30_000,
    retry: false,
  });
  const error = organizations.error ?? usage.error;
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

  return (
    <section
      aria-label="Cloud usage"
      className="border-border-subtle space-y-4 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-text-primary text-sm font-medium">Cloud usage</h4>
          {organizations.data?.items.length === 1 && (
            <p className="text-text-muted text-xs">{organizations.data.items[0].name}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(organizations.data?.items.length ?? 0) > 1 && (
            <Select value={orgId} onValueChange={setSelectedOrg}>
              <SelectTrigger aria-label="Usage organization" className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {organizations.data!.items.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh cloud usage"
            disabled={usage.isFetching || organizations.isFetching}
            onClick={() =>
              void (!orgId || organizations.isError ? organizations.refetch() : usage.refetch())
            }
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-text-muted text-sm">
          {error.message}
        </p>
      ) : usage.data ? (
        <>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-text-muted text-xs">Machines in use</dt>
              <dd className="text-text-primary mt-1 text-lg tabular-nums">
                {usage.data.activeReservations} / {usage.data.concurrencyLimit}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">Recorded runtime this month</dt>
              <dd className="text-text-primary mt-1 text-lg tabular-nums">
                {number.format(usage.data.runtimeMinutes)} min
              </dd>
            </div>
          </dl>
          <p className="text-text-muted text-xs">
            Starting machines and pending shutdowns use capacity. Runtime updates after machines
            pause or stop; paused time doesn’t count.
            {usage.data.estimatedRuntimeMs > 0 &&
              " Some runtime is estimated from lifecycle timestamps."}
          </p>
        </>
      ) : (
        <p role="status" className="text-text-muted text-sm">
          {organizations.isSuccess && !orgId
            ? "No cloud organization yet."
            : "Loading cloud usage…"}
        </p>
      )}
    </section>
  );
}
