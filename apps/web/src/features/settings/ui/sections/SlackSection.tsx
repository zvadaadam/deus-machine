import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, RefreshCw, Trash2, Unlink, Unplug } from "lucide-react";
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
import {
  dropRoutingRuleDraft,
  readRoutingRuleDraft,
  routingRuleDraftKey,
  writeRoutingRuleDraft,
} from "../../lib/routing-rule-drafts";
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
      toast.success("Slack workspace disconnected");
      // Close once the row is gone, so focus lands on a control that stays.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.settings.slack.installations(accountId, orgId),
      });
      setDisconnecting(null);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Couldn't disconnect Slack"),
  });

  const ready = !installations.isError && !installations.isPending && installations.data.configured;
  const connected = ready ? installations.data.installations : [];
  // The disconnect dialog opens from a plain button, so Radix has no trigger to return focus to.
  const opener = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLElement | null>(null);

  return (
    // Laid out like the routing rules: the action in the header, rows edge to edge below.
    <section
      ref={card}
      aria-labelledby="slack-workspace-heading"
      className="border-border-subtle overflow-hidden rounded-xl border"
    >
      <div className="p-4">
        <CardHeader
          id="slack-workspace-heading"
          title="Workspaces"
          description="The Slack workspaces where members can mention Deus."
          refreshing={installations.isFetching}
          onRefresh={() => void installations.refetch()}
          action={
            ready ? (
              <Button
                size="sm"
                onClick={() => connect.mutate(native.window.openExternalPending())}
                disabled={connect.isPending}
              >
                {connect.isPending ? "Opening…" : "Connect workspace"}
              </Button>
            ) : null
          }
        />
        {installations.isError ? (
          <div className="mt-4">
            <SettingsError
              message={installations.error.message}
              retry={() => void installations.refetch()}
            />
          </div>
        ) : installations.isPending ? (
          <p role="status" className="text-text-muted mt-4 text-sm">
            Loading Slack workspaces…
          </p>
        ) : !installations.data.configured ? (
          <p className="text-text-muted mt-4 text-sm">
            Slack isn&apos;t set up for this Deus deployment yet.
          </p>
        ) : null}
      </div>
      {ready &&
        (connected.length === 0 ? (
          <p className="border-border-subtle text-text-muted border-t px-4 py-6 text-center text-sm">
            No workspace connected yet. You&apos;ll confirm in your browser, then approve Deus in
            Slack.
          </p>
        ) : (
          <ul className="border-border-subtle divide-border-subtle divide-y border-t">
            {connected.map((installation) => (
              <li
                key={installation.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-text-primary truncate text-sm">{installation.teamName}</p>
                  <p className="text-text-muted mt-0.5 truncate text-xs">
                    Connected by {installation.installedBy?.name ?? "Unknown"} ·{" "}
                    {dateFormatter.format(new Date(installation.createdAt))}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-text-muted hover:text-destructive shrink-0"
                  aria-label={`Disconnect ${installation.teamName}`}
                  title={`Disconnect ${installation.teamName}`}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setDisconnecting(installation);
                  }}
                >
                  <Unplug className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ))}
      <Dialog open={!!disconnecting} onOpenChange={(open) => !open && setDisconnecting(null)}>
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => restoreFocus(event, opener.current, card.current)}
        >
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
  const [confirmingStop, setConfirmingStop] = useState(false);
  // The confirmation opens from a plain button, so Radix has no trigger to return focus to.
  const opener = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const stopSharing = useMutation({
    mutationFn: () => stopSharingCompanyModelAccount(orgId, new AbortController().signal),
    onSuccess: async () => {
      toast.success("Claude account is no longer shared");
      // Close once the row is gone, so focus lands on a control that stays.
      await refresh();
      setConfirmingStop(false);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Couldn't stop sharing"),
  });
  const needsClaudeAccount =
    !organization.data?.companyModelAccount &&
    !providerAccounts.isLoading &&
    (!hasClaudeAccount || missingProvider);

  const sharedAccount = organization.data?.companyModelAccount ?? null;
  const loadError = organization.isError
    ? { message: organization.error.message, retry: () => void organization.refetch() }
    : !sharedAccount && providerAccounts.isError
      ? { message: providerAccounts.error.message, retry: () => void providerAccounts.refetch() }
      : null;
  const ready = !loadError && !organization.isPending && !providerAccounts.isLoading;

  return (
    // Laid out like the other cards: the action in the header, the account as a row below.
    <section
      ref={card}
      aria-labelledby="slack-billing-heading"
      className="border-border-subtle overflow-hidden rounded-xl border"
    >
      <div className="p-4">
        <CardHeader
          id="slack-billing-heading"
          title="Who pays"
          description="Turns started from Slack run on the organization's shared Claude account."
          refreshing={organization.isFetching || providerAccounts.isFetching}
          onRefresh={() => void refresh()}
          action={
            !ready || sharedAccount ? null : needsClaudeAccount ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => uiActions.setActiveSettingsSection("ai")}
              >
                Open AI settings
              </Button>
            ) : (
              <Button size="sm" onClick={() => share.mutate()} disabled={share.isPending}>
                {share.isPending ? "Sharing…" : "Share my Claude account"}
              </Button>
            )
          }
        />
        {loadError ? (
          <div className="mt-4">
            <SettingsError message={loadError.message} retry={loadError.retry} />
          </div>
        ) : !ready ? (
          <p role="status" className="text-text-muted mt-4 text-sm">
            Loading shared account…
          </p>
        ) : null}
      </div>
      {ready &&
        (sharedAccount ? (
          <div className="border-border-subtle flex items-center justify-between gap-3 border-t px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-text-primary truncate text-sm">
                {sharedAccount.name}&apos;s Claude account
              </p>
              <p className="text-text-muted mt-0.5 text-xs">
                Every turn started from Slack runs on it.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-destructive shrink-0"
              aria-label={`Stop sharing ${sharedAccount.name}'s Claude account`}
              title="Stop sharing"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setConfirmingStop(true);
              }}
            >
              <Unlink className="size-3.5" />
            </Button>
          </div>
        ) : (
          <p className="border-border-subtle text-text-muted border-t px-4 py-6 text-center text-sm">
            {needsClaudeAccount
              ? "Connect a Claude account first, then share it here."
              : "No shared account yet. Slack requests can't start until a member shares one."}
          </p>
        ))}
      <Dialog open={confirmingStop} onOpenChange={(open) => !open && setConfirmingStop(false)}>
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => restoreFocus(event, opener.current, card.current)}
        >
          <DialogHeader>
            <DialogTitle>Stop sharing {sharedAccount?.name}&apos;s Claude account?</DialogTitle>
            <DialogDescription>
              Slack requests can&apos;t start until a member shares an account again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingStop(false)}
              disabled={stopSharing.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => stopSharing.mutate()}
              disabled={stopSharing.isPending}
            >
              {stopSharing.isPending ? "Stopping…" : "Stop sharing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RoutingRulesCard({ accountId, orgId }: { accountId: string; orgId: string }) {
  const queryClient = useQueryClient();
  // Closed, adding a rule (null), or editing the rule the person clicked. The
  // rule is kept as it was then, so a refetch can't turn an edit into an add.
  const [dialog, setDialog] = useState<{ rule: SharedEnvironment | null } | null>(null);
  // The dialog opens from plain buttons, so Radix has no trigger to return focus to.
  const opener = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const settings = useQuery({
    queryKey: queryKeys.settings.environments.detail(accountId, orgId, null),
    queryFn: ({ signal }) => getEnvironmentSecretSettings(orgId, null, signal),
    staleTime: 30_000,
    retry: false,
  });
  // The organization travels with each save: an Undo clicked after switching
  // organization still writes where the rule was deleted.
  const save = useMutation({
    mutationFn: (rule: { orgId: string; environmentId: string; description: string | null }) =>
      saveSlackEnvironmentDescription(
        rule.orgId,
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
    const deletedIn = orgId;
    // Undo restores only while nothing replaced the rule: one written meanwhile wins.
    const undo = async () => {
      const latest = await queryClient.fetchQuery({
        queryKey: queryKeys.settings.environments.detail(accountId, deletedIn, null),
        queryFn: ({ signal }) => getEnvironmentSecretSettings(deletedIn, null, signal),
        staleTime: 0,
      });
      if (latest.environments.find((environment) => environment.id === rule.id)?.description) {
        toast.info("That repository has a newer rule, so there is nothing to undo");
        return;
      }
      await save.mutateAsync({
        orgId: deletedIn,
        environmentId: rule.id,
        description: rule.description,
      });
    };
    save.mutateAsync({ orgId: deletedIn, environmentId: rule.id, description: null }).then(
      () =>
        toast("Routing rule deleted", {
          duration: 5000,
          action: {
            label: "Undo",
            onClick: () => void undo().catch((error: Error) => toast.error(error.message)),
          },
        }),
      (error: Error) => toast.error(error.message)
    );
  }

  const ready = !settings.isError && !settings.isPending && shared.length > 0;

  return (
    // The table is this card's body, edge to edge under one divider: a second
    // bordered box inside the card read as a card in a card.
    <section
      ref={card}
      aria-labelledby="slack-routing-heading"
      className="border-border-subtle overflow-hidden rounded-xl border"
    >
      <div className="p-4">
        <CardHeader
          id="slack-routing-heading"
          title="Repository routing"
          description="Rules that help Deus pick the right repository for a Slack request. A repository without a rule is only used when a request names it, and a request that fits no rule runs without a repository."
          refreshing={settings.isFetching}
          onRefresh={() => void settings.refetch()}
          action={
            ready && canEdit ? (
              <Button
                size="sm"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setDialog({ rule: null });
                }}
                disabled={rules.length === shared.length}
              >
                Add rule
              </Button>
            ) : null
          }
        />
        {settings.isError ? (
          <div className="mt-4">
            <SettingsError message={settings.error.message} retry={() => void settings.refetch()} />
          </div>
        ) : settings.isPending ? (
          <p role="status" className="text-text-muted mt-4 text-sm">
            Loading routing rules…
          </p>
        ) : shared.length === 0 ? (
          <p className="text-text-muted mt-4 text-sm">No shared repository environments yet.</p>
        ) : null}
      </div>
      {ready &&
        (rules.length === 0 ? (
          <p className="border-border-subtle text-text-muted border-t px-4 py-6 text-center text-sm">
            No rules yet, so Slack requests run without a repository unless they name one.
          </p>
        ) : (
          <div className="border-border-subtle @container/rules border-t">
            {/* Narrower than 32rem, the target moves under its description. */}
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-border-subtle text-text-muted border-b text-left text-xs">
                  <th scope="col" className="py-2 pr-3 pl-4 font-normal @lg/rules:w-1/2">
                    Description
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-normal @lg/rules:table-cell">
                    Target
                  </th>
                  {canEdit && (
                    <th scope="col" className="w-20 py-2 pr-4 pl-2">
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
                      <td className="text-text-primary py-2.5 pr-3 pl-4 align-top">
                        {/* Clamped only where Edit shows the whole text. */}
                        <p className={canEdit ? "line-clamp-2 break-words" : "break-words"}>
                          {rule.description}
                        </p>
                        <p
                          className={`text-text-muted mt-0.5 text-xs @lg/rules:hidden ${canEdit ? "truncate" : "break-all"}`}
                        >
                          {target.detail ? `${target.label} · ${target.detail}` : target.label}
                        </p>
                      </td>
                      <td className="hidden px-3 py-2.5 align-top @lg/rules:table-cell">
                        <p className={`text-text-secondary ${canEdit ? "truncate" : "break-all"}`}>
                          {target.label}
                        </p>
                        {target.detail && (
                          <p
                            className={`text-text-muted text-xs ${canEdit ? "truncate" : "break-all"}`}
                          >
                            {target.detail}
                          </p>
                        )}
                      </td>
                      {canEdit && (
                        <td className="py-1.5 pr-4 pl-2 text-right align-top whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-text-muted"
                            aria-label={`Edit the rule for ${target.label}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setDialog({ rule });
                            }}
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
        ))}
      {ready && !canEdit && (
        <p className="border-border-subtle text-text-muted border-t px-4 py-3 text-xs">
          Only owners and admins can change routing rules.
        </p>
      )}
      {dialog && (
        <RoutingRuleDialog
          key={dialog.rule?.id ?? "new"}
          draftKey={routingRuleDraftKey(accountId, orgId, dialog.rule?.id ?? null)}
          rule={dialog.rule ?? undefined}
          choices={shared.filter((environment) => !environment.description)}
          shared={shared}
          onClose={() => setDialog(null)}
          focusAfterClose={(event) => restoreFocus(event, opener.current, card.current)}
          onSave={(rule) => save.mutateAsync({ orgId, ...rule })}
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
  draftKey,
  rule,
  choices,
  shared,
  onClose,
  focusAfterClose,
  onSave,
}: {
  draftKey: string;
  rule: SharedEnvironment | undefined;
  choices: SharedEnvironment[];
  shared: SharedEnvironment[];
  onClose: () => void;
  focusAfterClose: (event: Event) => void;
  onSave: (rule: { environmentId: string; description: string }) => Promise<unknown>;
}) {
  const draft = readRoutingRuleDraft(draftKey);
  // A new rule's drafted target may have gained a rule meanwhile; keep the text only.
  const draftTarget =
    draft && choices.some((choice) => choice.id === draft.environmentId)
      ? draft.environmentId
      : undefined;
  // No preselected target: a default nobody noticed would route requests to it.
  const [environmentId, setEnvironmentId] = useState(rule?.id ?? draftTarget ?? "");
  const [description, setDescription] = useState(draft?.description ?? rule?.description ?? "");
  const edit = (next: { environmentId?: string; description?: string }) => {
    const value = { environmentId, description, ...next };
    setEnvironmentId(value.environmentId);
    setDescription(value.description);
    writeRoutingRuleDraft(draftKey, value);
  };
  const close = () => {
    dropRoutingRuleDraft(draftKey);
    onClose();
  };
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
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the rule");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && close()}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={focusAfterClose}>
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
              onChange={(event) => edit({ description: event.target.value })}
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
              <Select
                value={environmentId}
                onValueChange={(next) => edit({ environmentId: next })}
                disabled={saving}
              >
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
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
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

/**
 * Where focus goes when one of a card's dialogs closes: the button that opened
 * it, or the card's Refresh when that button went away (its row was removed)
 * or can't take focus (it is disabled once every environment has a rule).
 */
function restoreFocus(event: Event, opener: HTMLElement | null, card: HTMLElement | null) {
  const target =
    opener?.isConnected && !opener.matches(":disabled")
      ? opener
      : card?.querySelector<HTMLElement>("button[aria-label^='Refresh']");
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function CardHeader({
  id,
  title,
  description,
  refreshing,
  onRefresh,
  action,
}: {
  id: string;
  title: string;
  description: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** The card's main action, next to refresh. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h4 id={id} className="text-text-primary text-sm font-medium">
          {title}
        </h4>
        <p className="text-text-muted mt-1 text-sm">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action}
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
