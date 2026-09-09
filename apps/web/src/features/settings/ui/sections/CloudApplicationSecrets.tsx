import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import {
  getEnvironmentSecretSettings,
  listSecretOrganizations,
} from "../../api/environment-secrets.service";
import { EnvironmentSecretDialog, type SecretAction } from "./EnvironmentSecretDialog";

export const ENVIRONMENT_SECRETS_QUERY_KEY = ["settings", "environment-secrets"] as const;

export function CloudApplicationSecrets() {
  const session = useDeusCloudSession();
  const accountId = session.data?.signedIn ? session.data.accountId : null;
  return (
    <section className="space-y-4" aria-label="Application secrets">
      <div className="space-y-1">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="text-text-muted size-4" />
          Application secrets
        </h4>
        <p className="text-text-muted text-sm">
          API keys and private values for apps running in the cloud. Connect agent subscriptions in
          AI Providers.
        </p>
      </div>
      {accountId ? (
        <OrganizationSecrets key={accountId} accountId={accountId} />
      ) : (
        <p className="text-text-muted text-sm">
          Sign in to Deus Cloud to manage application secrets.
        </p>
      )}
    </section>
  );
}

function OrganizationSecrets({ accountId }: { accountId: string }) {
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const organizations = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, "orgs"],
    queryFn: ({ signal }) => listSecretOrganizations(signal),
    staleTime: 30_000,
    retry: false,
  });
  const orgId =
    selectedOrg ?? organizations.data?.currentOrganizationId ?? organizations.data?.items[0]?.id;
  if (organizations.isError)
    return <LoadError error={organizations.error} retry={() => void organizations.refetch()} />;
  if (!organizations.data)
    return (
      <p role="status" className="text-text-muted text-sm">
        Loading organizations…
      </p>
    );
  if (!orgId)
    return (
      <p className="text-text-muted text-sm">
        No cloud organization is available for this account.
      </p>
    );
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="secrets-org">Organization</Label>
        <Select value={orgId} onValueChange={setSelectedOrg}>
          <SelectTrigger id="secrets-org" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {organizations.data.items.map((org) => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <EnvironmentSecrets key={orgId} accountId={accountId} orgId={orgId} />
    </>
  );
}

function EnvironmentSecrets({ accountId, orgId }: { accountId: string; orgId: string }) {
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [action, setAction] = useState<SecretAction | null>(null);
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: [...ENVIRONMENT_SECRETS_QUERY_KEY, accountId, orgId, environmentId],
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId, environmentId, signal),
    staleTime: 30_000,
    retry: false,
  });
  const data = settings.data;
  if (settings.isError)
    return <LoadError error={settings.error} retry={() => void settings.refetch()} />;
  if (!data)
    return (
      <p role="status" className="text-text-muted text-sm">
        Checking secrets…
      </p>
    );
  const visible = data.secrets.filter(
    (secret) =>
      secret.appliesToAll || (environmentId && secret.environmentIds.includes(environmentId))
  );
  const missing = data.required.filter((item) => !item.source);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="secrets-environment">Environment</Label>
        <Select
          value={environmentId ?? "all"}
          onValueChange={(id) => {
            setAction(null);
            setEnvironmentId(id === "all" ? null : id);
          }}
        >
          <SelectTrigger id="secrets-environment" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Defaults for all environments</SelectItem>
            {data.environments.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                {env.repo?.replace(/^https?:\/\/github.com\//, "").replace(/\.git$/, "") ??
                  env.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {environmentId && (
        <div className="border-border-subtle space-y-2 border-b pb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Required values</p>
            <span className={`text-xs ${missing.length ? "text-warning" : "text-accent-green"}`}>
              {missing.length
                ? `${missing.length} missing`
                : data.required.length
                  ? "All values set"
                  : "None declared"}
            </span>
          </div>
          {data.required.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3 text-xs">
              <span className="font-mono">{item.name}</span>
              {item.source ? (
                <span className="text-text-muted flex items-center gap-1">
                  <Check className="size-3" />
                  {item.source === "configuration" ? "Set in recipe" : "Set"}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => setAction({ type: "add", name: item.name })}
                >
                  Set value
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Saved secrets</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh secrets"
            disabled={settings.isFetching}
            onClick={() => void settings.refetch()}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAction({ type: "add" })}>
            <Plus className="mr-1.5 size-3.5" />
            Add secret
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="text-text-muted text-sm">No application secrets in this scope yet.</p>
      ) : (
        <div className="divide-border-subtle divide-y">
          {visible.map((secret) => (
            <div
              key={secret.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs break-all">{secret.name}</p>
                <p className="text-text-muted mt-1 text-xs">
                  {secret.ownerType === "USER" ? "Personal" : "Shared"} ·{" "}
                  {secret.appliesToAll
                    ? "All environments"
                    : secret.environmentIds.length > 1
                      ? `${secret.environmentIds.length} environments`
                      : "This environment"}
                </p>
              </div>
              {(secret.ownerType === "USER" || data.canManageShared) && (
                <div className="flex shrink-0 items-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAction({ type: "replace", secret })}
                  >
                    Replace
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-text-muted hover:text-destructive"
                    onClick={() => setAction({ type: "delete", secret })}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-text-muted text-xs">
        Environment values take priority over defaults. Personal values win within the same scope.
        Changes apply to newly provisioned cloud workspaces.
      </p>
      {action && (
        <EnvironmentSecretDialog
          key={`${environmentId}:${action.type}:${action.type === "add" ? (action.name ?? "") : action.secret.id}`}
          action={action}
          settings={data}
          orgId={orgId}
          environmentId={environmentId}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_SECRETS_QUERY_KEY });
          }}
        />
      )}
    </div>
  );
}

function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2">
      <p className="text-destructive text-sm">{error.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
