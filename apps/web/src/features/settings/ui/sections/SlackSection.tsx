import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { defaultProviderAccount } from "@shared/types/provider-account";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { uiActions } from "@/shared/stores/uiStore";
import {
  PROVIDER_ACCOUNTS_QUERY_KEY,
  useProviderAccounts,
} from "../../api/provider-accounts.queries";
import {
  getEnvironmentSecretSettings,
  listSecretOrganizations,
} from "../../api/environment-secrets.service";
import { CloudSettingsError } from "../../api/cloud-settings.service";
import {
  disconnectSlackInstallation,
  getSlackInstallUrl,
  getSlackOrganization,
  listSlackInstallations,
  saveSlackEnvironmentDescription,
  shareCompanyModelAccount,
  stopSharingCompanyModelAccount,
  type SlackInstallation,
} from "../../api/slack.service";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function SlackSection() {
  const session = useDeusCloudSession();
  const signIn = useDeusCloudSignIn();
  const accountId = session.data?.signedIn ? session.data.accountId : null;

  if (session.isPending) {
    return (
      <p role="status" className="text-text-muted flex items-center gap-2 text-sm">
        <Loader2 className="size-3.5 animate-spin" /> Loading Slack settings…
      </p>
    );
  }

  if (!accountId) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Slack</h3>
          <p className="text-text-muted mt-1 text-sm">Sign in to Deus Cloud to connect Slack.</p>
        </div>
        <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
          {signIn.isPending ? "Waiting for browser…" : "Sign in to Deus Cloud"}
        </Button>
      </div>
    );
  }

  return <SlackSettings accountId={accountId} />;
}

function SlackSettings({ accountId }: { accountId: string }) {
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
    organizations.data?.items[0]?.id ??
    null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Slack</h3>
          <p className="text-text-muted mt-1 text-sm">
            Route Slack mentions to cloud agents in this organization.
          </p>
        </div>
        {(organizations.data?.items.length ?? 0) > 1 && (
          <Select value={orgId ?? ""} onValueChange={setSelectedOrg}>
            <SelectTrigger aria-label="Slack organization" className="w-auto max-w-full">
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
      </div>

      {organizations.isError ? (
        <SettingsError
          message={organizations.error.message}
          retry={() => void organizations.refetch()}
        />
      ) : organizations.isPending ? (
        <p role="status" className="text-text-muted text-sm">
          Loading organizations…
        </p>
      ) : !orgId ? (
        <p className="text-text-muted text-sm">No cloud organization yet.</p>
      ) : (
        <>
          <WorkspaceCard accountId={accountId} orgId={orgId} />
          <CompanyAccountCard accountId={accountId} orgId={orgId} />
          <SlackRepositoriesCard accountId={accountId} orgId={orgId} />
        </>
      )}
    </div>
  );
}

function WorkspaceCard({ accountId, orgId }: { accountId: string; orgId: string }) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<SlackInstallation | null>(null);
  const installations = useQuery({
    queryKey: queryKeys.settings.slack.installations(accountId, orgId),
    queryFn: ({ signal }) => listSlackInstallations(orgId, signal),
    staleTime: 30_000,
    // "always": returning from Slack's consent within staleTime must still show the result.
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const connect = useMutation({
    mutationFn: async () => {
      const result = await getSlackInstallUrl(orgId, new AbortController().signal);
      await native.window.openExternal(result.url);
    },
    onSuccess: () => toast.info("Approve Deus in Slack, then come back to Settings"),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't open Slack"),
  });
  const disconnect = useMutation({
    mutationFn: (installationId: string) =>
      disconnectSlackInstallation(orgId, installationId, new AbortController().signal),
    onSuccess: async () => {
      setDisconnecting(null);
      toast.success("Slack workspace disconnected");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.settings.slack.installations(accountId, orgId),
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Couldn't disconnect Slack"),
  });

  return (
    <section
      aria-labelledby="slack-workspace-heading"
      className="border-border-subtle space-y-4 rounded-xl border p-4"
    >
      <CardHeader
        id="slack-workspace-heading"
        title="Workspace"
        description="Connect the Slack workspace where members mention Deus."
        refreshing={installations.isFetching}
        onRefresh={() => void installations.refetch()}
      />
      {installations.isError ? (
        <SettingsError
          message={installations.error.message}
          retry={() => void installations.refetch()}
        />
      ) : installations.isPending ? (
        <p role="status" className="text-text-muted text-sm">
          Loading Slack workspace…
        </p>
      ) : !installations.data.configured ? (
        <p className="text-text-muted text-sm">
          Slack isn&apos;t set up for this Deus deployment yet.
        </p>
      ) : installations.data.installations.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-muted text-sm">
            You&apos;ll confirm in your browser, then approve Deus in Slack.
          </p>
          <Button size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
            {connect.isPending ? "Opening…" : "Connect Slack"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="divide-border-subtle divide-y">
            {installations.data.installations.map((installation) => (
              <div
                key={installation.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-text-primary truncate text-sm font-medium">
                    {installation.teamName}
                  </p>
                  <p className="text-text-muted mt-0.5 text-xs">
                    Connected by {installation.installedBy?.name ?? "Unknown"} ·{" "}
                    {dateFormatter.format(new Date(installation.createdAt))}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDisconnecting(installation)}>
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
          >
            {connect.isPending ? "Opening…" : "Connect another workspace"}
          </Button>
        </div>
      )}
      <Dialog open={!!disconnecting} onOpenChange={(open) => !open && setDisconnecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {disconnecting?.teamName}?</DialogTitle>
            <DialogDescription>
              Mentions in that Slack workspace stop working and Deus is removed from it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDisconnecting(null)}
              disabled={disconnect.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => disconnecting && disconnect.mutate(disconnecting.id)}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CompanyAccountCard({ accountId, orgId }: { accountId: string; orgId: string }) {
  const queryClient = useQueryClient();
  const providerAccounts = useProviderAccounts();
  const claudeAccount = defaultProviderAccount(providerAccounts.data, "claude");
  const hasClaudeAccount = claudeAccount?.status === "connected";
  const [missingProvider, setMissingProvider] = useState(false);
  const organization = useQuery({
    queryKey: queryKeys.settings.slack.organization(accountId, orgId),
    queryFn: ({ signal }) => getSlackOrganization(orgId, signal),
    staleTime: 30_000,
    retry: false,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.settings.slack.organization(accountId, orgId),
    });
    await queryClient.invalidateQueries({
      queryKey: [...PROVIDER_ACCOUNTS_QUERY_KEY, accountId],
    });
  };
  const share = useMutation({
    mutationFn: () => shareCompanyModelAccount(orgId, new AbortController().signal),
    onSuccess: async () => {
      setMissingProvider(false);
      toast.success("Claude account shared with your organization");
      await refresh();
    },
    onError: (error) => {
      if (
        error instanceof CloudSettingsError &&
        error.status === 409 &&
        error.code === "NO_PROVIDER_ACCOUNT"
      ) {
        setMissingProvider(true);
        toast.error("Connect a Claude account first");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Couldn't share Claude account");
    },
  });
  const stopSharing = useMutation({
    mutationFn: () => stopSharingCompanyModelAccount(orgId, new AbortController().signal),
    onSuccess: async () => {
      toast.success("Claude account is no longer shared");
      await refresh();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Couldn't stop sharing"),
  });
  const needsClaudeAccount =
    !organization.data?.companyModelAccount &&
    !providerAccounts.isLoading &&
    (!hasClaudeAccount || missingProvider);

  return (
    <section
      aria-labelledby="slack-billing-heading"
      className="border-border-subtle space-y-4 rounded-xl border p-4"
    >
      <CardHeader
        id="slack-billing-heading"
        title="Who pays"
        description="Turns started from Slack run on the organization's shared Claude account."
        refreshing={organization.isFetching || providerAccounts.isFetching}
        onRefresh={() => void refresh()}
      />
      {organization.isError ? (
        <SettingsError
          message={organization.error.message}
          retry={() => void organization.refetch()}
        />
      ) : !organization.data?.companyModelAccount && providerAccounts.isError ? (
        <SettingsError
          message={providerAccounts.error.message}
          retry={() => void providerAccounts.refetch()}
        />
      ) : organization.isPending || providerAccounts.isLoading ? (
        <p role="status" className="text-text-muted text-sm">
          Loading shared account…
        </p>
      ) : organization.data?.companyModelAccount ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-primary text-sm">
            {organization.data.companyModelAccount.name}&apos;s Claude account
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stopSharing.mutate()}
            disabled={stopSharing.isPending}
          >
            {stopSharing.isPending ? "Stopping…" : "Stop sharing"}
          </Button>
        </div>
      ) : needsClaudeAccount ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-muted text-sm">Connect a Claude account first</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => uiActions.setActiveSettingsSection("ai")}
          >
            Open AI settings
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-muted text-sm">
            No shared account yet. Slack requests can&apos;t start until a member shares one.
          </p>
          <Button size="sm" onClick={() => share.mutate()} disabled={share.isPending}>
            {share.isPending ? "Sharing…" : "Share my Claude account"}
          </Button>
        </div>
      )}
    </section>
  );
}

function SlackRepositoriesCard({ accountId, orgId }: { accountId: string; orgId: string }) {
  const settings = useQuery({
    queryKey: queryKeys.settings.environments.detail(accountId, orgId, null),
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId, null, signal),
    staleTime: 30_000,
    retry: false,
  });
  const sharedEnvironments =
    settings.data?.environments.filter((environment) => environment.ownerType === "ORG") ?? [];

  return (
    <section
      aria-labelledby="slack-repositories-heading"
      className="border-border-subtle space-y-4 rounded-xl border p-4"
    >
      <CardHeader
        id="slack-repositories-heading"
        title="Repositories"
        description="Deus picks the repository whose description matches the request. A repository without a description is only used when a request names it."
        refreshing={settings.isFetching}
        onRefresh={() => void settings.refetch()}
      />
      {settings.isError ? (
        <SettingsError message={settings.error.message} retry={() => void settings.refetch()} />
      ) : settings.isPending ? (
        <p role="status" className="text-text-muted text-sm">
          Loading repositories…
        </p>
      ) : sharedEnvironments.length === 0 ? (
        <p className="text-text-muted text-sm">No shared repository environments yet.</p>
      ) : (
        <div className="divide-border-subtle divide-y">
          {!settings.data.canManageShared && (
            <p className="text-text-muted pb-3 text-sm">
              Only owners and admins can edit descriptions.
            </p>
          )}
          {sharedEnvironments.map((environment) => (
            <DescriptionRow
              key={`${environment.id}:${environment.description ?? ""}`}
              orgId={orgId}
              environment={environment}
              canEdit={settings.data.canManageShared}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DescriptionRow({
  orgId,
  environment,
  canEdit,
}: {
  orgId: string;
  environment: { id: string; name: string; repo: string | null; description: string | null };
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(environment.description ?? "");
  const save = useMutation({
    mutationFn: (description: string | null) =>
      saveSlackEnvironmentDescription(
        orgId,
        environment.id,
        description,
        new AbortController().signal
      ),
    onSuccess: async (saved) => {
      setValue(saved.description ?? "");
      toast.success("Repository description saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.environments.all });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Couldn't save description"),
  });
  const current = environment.description ?? "";
  const trimmed = value.trim();
  const changed = trimmed !== current;

  return (
    <div className="space-y-3 py-4">
      <div>
        <p className="text-text-primary text-sm font-medium">{environment.name}</p>
        {environment.repo && <p className="text-text-muted mt-0.5 text-xs">{environment.repo}</p>}
      </div>
      <Textarea
        aria-label={`${environment.name} Slack routing description`}
        maxLength={1000}
        placeholder="backend API, billing, database migrations"
        value={value}
        readOnly={!canEdit}
        onChange={(event) => setValue(event.target.value)}
      />
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => save.mutate(trimmed || null)}
            disabled={!changed || value.length > 1000 || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue("");
              save.mutate(null);
            }}
            disabled={!current || save.isPending}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function CardHeader({
  id,
  title,
  description,
  refreshing,
  onRefresh,
}: {
  id: string;
  title: string;
  description: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h4 id={id} className="text-text-primary text-sm font-medium">
          {title}
        </h4>
        <p className="text-text-muted mt-1 text-sm">{description}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Refresh ${title.toLowerCase()}`}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw className="size-3.5" />
      </Button>
    </div>
  );
}

function SettingsError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2">
      <p className="text-accent-red-muted text-sm">{message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
