import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { match, P } from "ts-pattern";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uiActions } from "@/shared/stores/uiStore";
import {
  defaultProviderAccount,
  type ProviderAccount,
  type ProviderAccounts as ProviderAccountsData,
  type ProviderAuthMethod,
  type ProviderDefinition,
  type ProviderLogin,
  type ProviderLoginOptions,
} from "@shared/types/provider-account";
import {
  PROVIDER_ACCOUNTS_QUERY_KEY,
  useProviderAccounts,
} from "../../api/provider-accounts.queries";
import {
  cancelProviderAccountLogin,
  saveProviderAccountSecret,
  disconnectProviderAccount,
  startProviderAccountLogin,
  updateProviderAccount,
  waitForProviderAccountLogin,
} from "../../api/provider-accounts.service";
import { ProviderAccountRow } from "./ProviderAccountRow";

type ConnectionState =
  | { stage: "idle" }
  | { stage: "starting" | "saving" }
  | { stage: "waiting"; login: ProviderLogin }
  | { stage: "error"; message: string; retry?: ProviderLoginOptions };

/** The cloud advertises the providers and connection methods it can actually run. */
export function ProviderAccounts(): ReactElement {
  return (
    <section aria-label="Cloud provider accounts" className="space-y-4">
      <div>
        <h4 className="text-text-primary text-sm font-medium">Deus Cloud</h4>
        <p className="text-text-muted mt-1 text-sm">
          Choose the account each cloud agent uses. Saved accounts stay private to your Deus login
          and do not change your local CLI login.
        </p>
      </div>
      <ProviderAccountsContent />
    </section>
  );
}

function ProviderAccountsContent(): ReactElement | null {
  const query = useProviderAccounts();
  const { accountId, data } = query;
  if (!accountId) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => uiActions.setActiveSettingsSection("account")}
      >
        Sign in to Deus Cloud
      </Button>
    );
  }
  if (query.isLoading) {
    return (
      <p role="status" className="text-text-muted flex items-center gap-2 text-sm">
        <Loader2 className="size-3.5 animate-spin" /> Loading provider accounts…
      </p>
    );
  }
  if (query.error && !data) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-accent-red-muted text-sm">{query.error.message}</p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) return null;
  return (
    <>
      {query.error && (
        <p role="alert" className="text-accent-red-muted text-sm">
          Couldn't refresh saved accounts. {query.error.message}
        </p>
      )}
      {data.providers.map((provider) => (
        <ProviderAccountPanel
          key={`${accountId}:${provider.id}`}
          ownerAccountId={accountId}
          provider={provider}
          data={data}
        />
      ))}
      <p className="text-text-muted text-xs">
        Defaults apply to new cloud turns. Running and queued turns keep the account they started
        with.
      </p>
    </>
  );
}

function ProviderAccountPanel({
  provider,
  data,
  ownerAccountId,
}: {
  provider: ProviderDefinition;
  data: ProviderAccountsData;
  ownerAccountId: string;
}): ReactElement {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [method, setMethod] = useState<ProviderAuthMethod>(
    provider.authMethods.includes("subscription") ? "subscription" : "api_key"
  );
  const [replaceAccountId, setReplaceAccountId] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>({ stage: "idle" });
  const pending = useRef<{ controller: AbortController; loginId?: string } | null>(null);
  const mounted = useRef(true);
  const secretInput = useRef<HTMLInputElement>(null);
  const selected = defaultProviderAccount(data, provider.id);
  const accounts = data.accounts.filter((account) => account.provider === provider.id);
  const subscriptionName = provider.subscriptionName ?? provider.name;
  const tokenSetup = provider.subscriptionTokenSetup;
  const readsSecret = method === "api_key" || Boolean(tokenSetup);
  const secretLabel = method === "api_key" ? "API key" : "subscription token";
  const busy =
    connection.stage === "starting" ||
    connection.stage === "saving" ||
    connection.stage === "waiting";

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: [...PROVIDER_ACCOUNTS_QUERY_KEY, ownerAccountId],
    });
    await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.controller.abort();
      pending.current = null;
      // Do not cancel with a new user's bearer after identity change. The
      // abandoned login expires or is replaced by that owner's next login.
    };
  }, []);

  useEffect(() => {
    if (replaceAccountId) secretInput.current?.focus();
  }, [replaceAccountId]);

  const action = useMutation({
    retry: false,
    mutationFn: (change: { kind: "default" | "disconnect"; id: string }) =>
      change.kind === "default"
        ? updateProviderAccount(change.id, { isDefault: true })
        : disconnectProviderAccount(change.id),
    onSuccess: async (_result, change) => {
      if (!mounted.current) return;
      await refresh();
      if (mounted.current)
        toast.success(
          change.kind === "default"
            ? `Default ${provider.name} account updated`
            : `${provider.name} account disconnected`
        );
    },
    onError: (error) => {
      if (mounted.current) toast.error(error.message);
    },
  });

  const resetForm = () => {
    setSecret("");
    setLabel("");
    setReplaceAccountId(undefined);
    setConnection({ stage: "idle" });
  };

  const startLogin = async (options: ProviderLoginOptions) => {
    if (pending.current) return;
    const current = { controller: new AbortController(), loginId: undefined as string | undefined };
    pending.current = current;
    setConnection({ stage: "starting" });
    try {
      const login = await startProviderAccountLogin(options, current.controller.signal);
      if (current.controller.signal.aborted) return;
      current.loginId = login.loginId;
      setConnection({ stage: "waiting", login });
      await waitForProviderAccountLogin(login.loginId, current.controller.signal);
      if (current.controller.signal.aborted) return;
      resetForm();
      await refresh();
      if (mounted.current) toast.success(`${provider.name} account connected`);
    } catch (error) {
      if (!current.controller.signal.aborted)
        setConnection({
          stage: "error",
          message: error instanceof Error ? error.message : "Sign-in failed.",
          retry: options,
        });
    } finally {
      if (pending.current === current) pending.current = null;
    }
  };

  const saveSecret = async () => {
    if (pending.current || !secret.trim()) return;
    const value = secret.trim();
    setSecret("");
    const current = { controller: new AbortController() };
    pending.current = current;
    setConnection({ stage: "saving" });
    try {
      // A direct request keeps secret-bearing variables out of Query's mutation cache.
      await saveProviderAccountSecret(
        {
          provider: provider.id,
          authMethod: method,
          secret: value,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(replaceAccountId ? { replaceAccountId } : {}),
        },
        current.controller.signal
      );
      if (current.controller.signal.aborted) return;
      resetForm();
      await refresh();
      if (mounted.current) toast.success(`${provider.name} ${secretLabel} connected`);
    } catch (error) {
      if (!current.controller.signal.aborted)
        setConnection({
          stage: "error",
          message: error instanceof Error ? error.message : "Couldn't save the credential.",
        });
    } finally {
      if (pending.current === current) pending.current = null;
    }
  };

  const cancelConnection = async () => {
    const current = pending.current;
    pending.current = null;
    current?.controller.abort();
    resetForm();
    if (current?.loginId) {
      try {
        await cancelProviderAccountLogin(current.loginId);
      } catch (error) {
        if (mounted.current)
          toast.error(
            error instanceof Error
              ? error.message
              : "Couldn't cancel sign-in. The code will expire automatically."
          );
      }
    }
  };

  function reconnectAccount(account: ProviderAccount): void {
    if (account.authMethod === "subscription" && !tokenSetup) {
      void startLogin({
        provider: provider.id,
        replaceAccountId: account.id,
        label: account.label,
      });
      return;
    }
    setMethod(account.authMethod);
    setReplaceAccountId(account.id);
    setLabel(account.label);
    setSecret("");
    setConnection({ stage: "idle" });
  }

  let defaultWarning = `Choose a default account or add an account to use ${provider.name} in the cloud.`;
  if (selected) {
    let recovery = "Reconnect it";
    if (selected.authMethod === "api_key") recovery = "Replace its API key";
    else if (tokenSetup) recovery = "Replace its token";
    defaultWarning = `Your default ${provider.name} account needs attention. ${recovery} or choose another default.`;
  }
  let submitLabel = `Connect ${subscriptionName}`;
  if (method === "api_key") {
    submitLabel = replaceAccountId ? "Save replacement key" : "Add API key";
  } else if (replaceAccountId && readsSecret) {
    submitLabel = "Save replacement token";
  }

  return (
    <section
      aria-label={`${provider.name} cloud accounts`}
      className="border-border-subtle space-y-3 rounded-lg border p-4"
    >
      <div>
        <h5 className="text-text-primary text-sm font-medium">{provider.name}</h5>
        <p className="text-text-muted text-sm">{provider.vendor}</p>
      </div>
      {data.defaultAccountIds[provider.id] && selected?.status !== "connected" && (
        <p role="alert" className="text-accent-red-muted text-sm">
          {defaultWarning} Deus will not switch accounts or billing methods automatically.
        </p>
      )}
      <div className="divide-border-subtle divide-y">
        {accounts.map((account) => (
          <ProviderAccountRow
            key={account.id}
            provider={provider}
            account={account}
            isDefault={account.id === data.defaultAccountIds[provider.id]}
            disabled={busy || action.isPending}
            onReconnect={reconnectAccount}
            onDefault={(id) => action.mutate({ kind: "default", id })}
            onDisconnect={(id) => action.mutate({ kind: "disconnect", id })}
          />
        ))}
      </div>
      {match(connection)
        .with({ stage: "waiting" }, ({ login }) => (
          <ProviderDeviceLogin
            provider={provider}
            login={login}
            onCancel={() => void cancelConnection()}
          />
        ))
        .with({ stage: P.union("starting", "saving") }, ({ stage }) => (
          <div className="flex items-center gap-2">
            <p role="status" className="text-text-muted flex items-center gap-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" />
              {stage === "starting" ? "Preparing sign-in…" : `Validating ${secretLabel}…`}
            </p>
            {stage === "starting" && (
              <Button size="sm" variant="ghost" onClick={() => void cancelConnection()}>
                Cancel
              </Button>
            )}
          </div>
        ))
        .with({ stage: P.union("idle", "error") }, (state) => (
          <>
            {state.stage === "error" && (
              <div role="alert" className="space-y-2">
                <p className="text-accent-red-muted text-sm">{state.message}</p>
                {state.retry && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (state.retry) void startLogin(state.retry);
                    }}
                  >
                    Try again
                  </Button>
                )}
              </div>
            )}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!provider.authMethods.includes(method)) return;
                if (readsSecret) void saveSecret();
                else
                  void startLogin({
                    provider: provider.id,
                    ...(label.trim() ? { label: label.trim() } : {}),
                  });
              }}
            >
              {replaceAccountId ? (
                <p className="text-text-primary text-sm">
                  Replace {secretLabel} for {label}
                </p>
              ) : (
                provider.authMethods.length > 1 && (
                  <div
                    role="group"
                    aria-label={`${provider.name} connection method`}
                    className="flex flex-wrap gap-1"
                  >
                    {provider.authMethods.map((option) => (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={method === option ? "secondary" : "ghost"}
                        aria-pressed={method === option}
                        disabled={action.isPending}
                        onClick={() => {
                          setMethod(option);
                          setSecret("");
                          setConnection({ stage: "idle" });
                        }}
                      >
                        {option === "api_key" ? "API key" : `${subscriptionName} subscription`}
                      </Button>
                    ))}
                  </div>
                )
              )}
              <Input
                aria-label={`${provider.name} account name`}
                placeholder="Account name (optional)"
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="max-w-xs"
                disabled={action.isPending}
              />
              {method === "subscription" && tokenSetup && (
                <div className="space-y-2">
                  <p className="text-text-muted text-xs">{provider.subscriptionInstructions}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-text-primary text-sm">{tokenSetup.command}</code>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Copy setup command"
                      onClick={() =>
                        void navigator.clipboard.writeText(tokenSetup.command).then(
                          () => toast.success("Command copied"),
                          () =>
                            toast.error("Couldn't copy. Select the command and copy it manually.")
                        )
                      }
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <a
                      className="text-text-muted text-xs underline"
                      href={tokenSetup.documentationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Setup instructions
                    </a>
                  </div>
                </div>
              )}
              {readsSecret && (
                <>
                  <Input
                    ref={secretInput}
                    aria-label={`${provider.name} ${secretLabel}`}
                    type="password"
                    autoComplete="off"
                    placeholder={`Paste ${secretLabel}`}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    disabled={action.isPending}
                  />
                  <p className="text-text-muted text-xs">
                    {method === "api_key"
                      ? `API usage is billed by ${provider.vendor}.`
                      : `Uses your ${subscriptionName} subscription.`}{" "}
                    Saved credentials are encrypted and are never shown again.
                  </p>
                </>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={
                    action.isPending ||
                    !provider.authMethods.includes(method) ||
                    (readsSecret && !secret.trim())
                  }
                >
                  {submitLabel}
                </Button>
                {replaceAccountId && (
                  <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                    Cancel replacement
                  </Button>
                )}
              </div>
            </form>
          </>
        ))
        .exhaustive()}
    </section>
  );
}

export function ProviderDeviceLogin({
  provider,
  login,
  onCancel,
}: {
  provider: ProviderDefinition;
  login: ProviderLogin;
  onCancel: () => void;
}): ReactElement {
  const name = provider.subscriptionName ?? provider.name;
  return (
    <div className="border-border-subtle bg-bg-muted space-y-3 rounded-lg border p-3">
      <p className="text-text-primary text-sm font-medium">Finish signing in to {name}</p>
      <p className="text-text-muted text-sm">
        Open {name} and enter this code.
        {provider.subscriptionInstructions && ` ${provider.subscriptionInstructions}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-text-primary text-base font-semibold tracking-wider">
          {login.userCode}
        </code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy sign-in code"
          onClick={() =>
            void navigator.clipboard.writeText(login.userCode).then(
              () => toast.success("Code copied"),
              () => toast.error("Couldn't copy. Select the code and copy it manually.")
            )
          }
        >
          <Copy className="size-3.5" />
        </Button>
        <Button size="sm" asChild>
          <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
            Open {name} <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
      <p role="status" className="text-text-muted flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        Waiting for approval · code expires at{" "}
        {new Date(login.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </p>
      <Button size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
