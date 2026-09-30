import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { native } from "@/platform";
import type { PendingExternalWindow } from "@/platform/native/window";
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
import { routingTarget } from "../../lib/slack-routing";

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

  if (accountId) return <SlackSettings accountId={accountId} />;

  // A failed read or a locked keyring is not "signed out": the session is still on this device.
  const locked = session.data?.vaultLocked === true;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Slack</h3>
        <p className="text-text-muted mt-1 text-sm">
          {session.isError
            ? "Couldn't check your Deus Cloud session."
            : locked
              ? "Unlock your computer's keyring, then reopen Deus."
              : "Sign in to Deus Cloud to connect Slack."}
        </p>
      </div>
      {session.isError ? (
        <Button size="sm" variant="outline" onClick={() => void session.refetch()}>
          Retry
        </Button>
      ) : locked ? null : (
        <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
          {signIn.isPending ? "Waiting for browser…" : "Sign in to Deus Cloud"}
        </Button>
      )}
    </div>
  );
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
          <RoutingRulesCard accountId={accountId} orgId={orgId} />
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
    retry: false,
  });
  const { refetch: refetchInstallations } = installations;
  // Coming back from Slack's consent shows the new workspace, however recently the list loaded.
  useEffect(() => native.window.onFocus(() => void refetchInstallations()), [refetchInstallations]);
  const connect = useMutation({
    // The tab is reserved in the click itself: a browser blocks one opened after the request.
    mutationFn: async (tab: PendingExternalWindow) => {
      try {
        const result = await getSlackInstallUrl(orgId, new AbortController().signal);
        await tab.open(result.url);
      } catch (error) {
        tab.cancel();
        throw error;
      }
    },
    // A retry would reuse the tab the failure closed, and can't open one outside the click.
    retry: false,
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
          <Button
            size="sm"
            onClick={() => connect.mutate(native.window.openExternalPending())}
            disabled={connect.isPending}
          >
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
            onClick={() => connect.mutate(native.window.openExternalPending())}
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

function RoutingRulesCard({ accountId, orgId }: { accountId: string; orgId: string }) {
  const queryClient = useQueryClient();
  // Closed, adding a rule (null), or editing the rule the person clicked. The
  // rule is kept as it was then, so a refetch can't turn an edit into an add.
  const [dialog, setDialog] = useState<{ rule: SharedEnvironment | null } | null>(null);
  const settings = useQuery({
    queryKey: queryKeys.settings.environments.detail(accountId, orgId, null),
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId, null, signal),
    staleTime: 30_000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (rule: { environmentId: string; description: string | null }) =>
      saveSlackEnvironmentDescription(
        orgId,
        rule.environmentId,
        rule.description,
        new AbortController().signal
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.environments.all }),
  });
  // A rule is a shared environment's description; the router reads nothing else.
  const shared =
    settings.data?.environments.filter((environment) => environment.ownerType === "ORG") ?? [];
  const rules = shared.filter((environment) => environment.description);
  const canEdit = settings.data?.canManageShared ?? false;

  // Promises, not mutate()'s per-call callbacks: those fire only for the
  // latest call, so a save made meanwhile would swallow this toast and its Undo.
  function remove(rule: { id: string; description: string | null }) {
    save.mutateAsync({ environmentId: rule.id, description: null }).then(
      () =>
        toast("Routing rule deleted", {
          duration: 5000,
          action: {
            label: "Undo",
            onClick: () =>
              void save
                .mutateAsync({ environmentId: rule.id, description: rule.description })
                .catch((error: Error) => toast.error(error.message)),
          },
        }),
      (error: Error) => toast.error(error.message)
    );
  }

  return (
    <section
      aria-labelledby="slack-routing-heading"
      className="border-border-subtle space-y-4 rounded-xl border p-4"
    >
      <CardHeader
        id="slack-routing-heading"
        title="Repository routing"
        description="Rules that help Deus pick the right repository for a Slack request. A repository without a rule is only used when a request names it."
        refreshing={settings.isFetching}
        onRefresh={() => void settings.refetch()}
      />
      {settings.isError ? (
        <SettingsError message={settings.error.message} retry={() => void settings.refetch()} />
      ) : settings.isPending ? (
        <p role="status" className="text-text-muted text-sm">
          Loading routing rules…
        </p>
      ) : shared.length === 0 ? (
        <p className="text-text-muted text-sm">No shared repository environments yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-text-secondary text-sm">
              {rules.length} routing {rules.length === 1 ? "rule" : "rules"}
            </p>
            {canEdit && (
              <Button
                size="sm"
                onClick={() => setDialog({ rule: null })}
                disabled={rules.length === shared.length}
              >
                Add rule
              </Button>
            )}
          </div>
          {rules.length === 0 ? (
            <p className="text-text-muted text-sm">
              No rules yet. Add one so Deus can pick a repository without being told.
            </p>
          ) : (
            <div className="border-border-subtle @container/rules overflow-hidden rounded-lg border">
              {/* Narrower than 32rem, the target moves under its description. */}
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-border-subtle text-text-muted border-b text-left text-xs">
                    <th scope="col" className="px-3 py-2 font-normal @lg/rules:w-1/2">
                      Description
                    </th>
                    <th scope="col" className="hidden px-3 py-2 font-normal @lg/rules:table-cell">
                      Target
                    </th>
                    {canEdit && (
                      <th scope="col" className="w-18 px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-border-subtle divide-y">
                  {rules.map((rule) => {
                    const target = routingTarget(rule, shared);
                    return (
                      <tr key={rule.id}>
                        <td className="text-text-primary px-3 py-2.5 align-top">
                          {/* Clamped only where Edit shows the whole text. */}
                          <p className={canEdit ? "line-clamp-2 break-words" : "break-words"}>
                            {rule.description}
                          </p>
                          <p className="text-text-muted mt-0.5 truncate text-xs @lg/rules:hidden">
                            {target.detail ? `${target.label} · ${target.detail}` : target.label}
                          </p>
                        </td>
                        <td className="hidden px-3 py-2.5 align-top @lg/rules:table-cell">
                          <p className="text-text-secondary truncate">{target.label}</p>
                          {target.detail && (
                            <p className="text-text-muted truncate text-xs">{target.detail}</p>
                          )}
                        </td>
                        {canEdit && (
                          <td className="px-2 py-1.5 text-right align-top whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-text-muted"
                              aria-label={`Edit the rule for ${target.label}`}
                              onClick={() => setDialog({ rule })}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-text-muted hover:text-destructive"
                              aria-label={`Delete the rule for ${target.label}`}
                              onClick={() => remove(rule)}
                              disabled={save.isPending}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!canEdit && (
            <p className="text-text-muted text-xs">
              Only owners and admins can change routing rules.
            </p>
          )}
        </div>
      )}
      {dialog && (
        <RoutingRuleDialog
          key={dialog.rule?.id ?? "new"}
          rule={dialog.rule ?? undefined}
          choices={shared.filter((environment) => !environment.description)}
          shared={shared}
          onClose={() => setDialog(null)}
          onSave={(rule) => save.mutateAsync(rule)}
        />
      )}
    </section>
  );
}

type SharedEnvironment = {
  id: string;
  name: string;
  repo: string | null;
  description: string | null;
};

/** Add a rule for an environment without one, or edit one rule's description. */
function RoutingRuleDialog({
  rule,
  choices,
  shared,
  onClose,
  onSave,
}: {
  rule: SharedEnvironment | undefined;
  choices: SharedEnvironment[];
  shared: SharedEnvironment[];
  onClose: () => void;
  onSave: (rule: { environmentId: string; description: string }) => Promise<unknown>;
}) {
  // No preselected target: a default nobody noticed would route requests to it.
  const [environmentId, setEnvironmentId] = useState(rule?.id ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = description.trim();
  const describe = (environment: SharedEnvironment) => {
    const target = routingTarget(environment, shared);
    return target.detail ? `${target.label} · ${target.detail}` : target.label;
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ environmentId, description: trimmed });
      toast.success(rule ? "Routing rule saved" : "Routing rule added");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the rule");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{rule ? "Edit routing rule" : "Add routing rule"}</DialogTitle>
            <DialogDescription>
              Deus works in the target repository when a Slack request matches the description.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="routing-rule-description">Description</Label>
            <Textarea
              id="routing-rule-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Requests about the backend API, billing or database migrations"
              maxLength={1000}
              disabled={saving}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="routing-rule-target">Target</Label>
            {rule ? (
              <p id="routing-rule-target" className="text-text-secondary text-sm">
                {describe(rule)}
              </p>
            ) : (
              <Select value={environmentId} onValueChange={setEnvironmentId} disabled={saving}>
                <SelectTrigger id="routing-rule-target" className="w-full">
                  <SelectValue placeholder="Choose a repository" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {describe(environment)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !environmentId || !trimmed || trimmed === (rule?.description ?? "") || saving
              }
            >
              {saving ? "Saving…" : rule ? "Save rule" : "Add rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
