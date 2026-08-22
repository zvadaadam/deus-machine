import { useState } from "react";
import { githubRepoSlug } from "@shared/git-origin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, Cloud, Copy, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import {
  getSession as getDeusCloudSession,
  retryProvision,
  type ClaudeSubscriptionState,
  disconnectClaudeSubscription,
  disconnectCodexSubscription,
  getClaudeSubscriptionStatus,
  getCodexSubscriptionStatus,
  getGithubAppStatus,
  importCodexAuth,
  installGithubApp,
  openAgentSetupTerminal,
  saveClaudeSubscriptionToken,
} from "@/platform/native/deus-cloud";

/**
 * Agent subscription setups. One entry per agent — adding an agent here
 * (plus its mint command in the main-process registry and a credential slot)
 * is the whole cost of a new personal-plan integration.
 */
const AGENT_SUBSCRIPTIONS = [
  {
    id: "claude-code",
    name: "Claude Code",
    available: true,
    kind: "paste" as const,
    command: "claude setup-token",
    placeholder: "sk-ant-oat…",
    instructions:
      "Run this in a terminal, approve in the browser, then paste the token it prints. One-year token, stored encrypted, streamed per turn — the cloud agent never sees it.",
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    kind: "import" as const,
    command: "codex login --device-auth",
    placeholder: null,
    instructions:
      "Enable device authorization in ChatGPT security settings, run this in a terminal and approve the code, then import the credential it writes. Stored encrypted; cloud turns activate with Codex cloud support.",
  },
] as const;

interface CloudSettings {
  enabled: boolean;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  hasGithubToken: boolean;
}

/**
 * Cloud workspaces settings — connection status + the org GitHub token that
 * unlocks private repos in sandboxes (stored as an encrypted agnt secret,
 * never persisted in deus).
 */
export function CloudSection() {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const [token, setToken] = useState("");
  const [subToken, setSubToken] = useState("");
  // One agent row expanded at a time — compact list, setup opens inline.
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [openGithub, setOpenGithub] = useState<"app" | "pat" | null>(null);

  const sub = useQuery({
    queryKey: ["settings", "claude-subscription"],
    queryFn: getClaudeSubscriptionStatus,
    staleTime: 30_000,
    retry: false,
  });

  const codexSub = useQuery({
    queryKey: ["settings", "codex-subscription"],
    queryFn: getCodexSubscriptionStatus,
    staleTime: 30_000,
    retry: false,
  });

  const codexAction = useMutation({
    mutationFn: async (action: { kind: "import" } | { kind: "disconnect" }) => {
      const result =
        action.kind === "import" ? await importCodexAuth() : await disconnectCodexSubscription();
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: async (result) => {
      toast.success(
        result.hasCodexSubscription
          ? "Codex subscription imported — activates with Codex cloud support"
          : "Codex subscription disconnected"
      );
      await queryClient.invalidateQueries({ queryKey: ["settings", "codex-subscription"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Codex action failed"),
  });

  const subAction = useMutation({
    mutationFn: async (action: { kind: "disconnect" } | { kind: "paste"; token: string }) => {
      const result: ClaudeSubscriptionState =
        action.kind === "paste"
          ? await saveClaudeSubscriptionToken(action.token)
          : await disconnectClaudeSubscription();
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: async (result) => {
      setSubToken("");
      toast.success(
        result.hasClaudeSubscription
          ? "Claude subscription connected — cloud agents run on your plan"
          : "Claude subscription disconnected"
      );
      await queryClient.invalidateQueries({ queryKey: ["settings", "claude-subscription"] });
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Subscription action failed"),
  });

  const localRepos = useQuery({
    queryKey: ["repos"],
    queryFn: () => apiClient.get<Array<{ id: string; git_origin_url: string | null }>>("/repos"),
    staleTime: 60_000,
    retry: false,
  });

  const githubApp = useQuery({
    queryKey: ["settings", "github-app"],
    queryFn: getGithubAppStatus,
    staleTime: 30_000,
    retry: false,
  });

  // Same key AccountSection uses, so signing in/out there refreshes this
  // section too — a private key here would keep showing a stale session
  // (and a stale "setup didn't finish" banner) until the settings remount.
  const session = useQuery({
    queryKey: queryKeys.deusCloud.session,
    queryFn: getDeusCloudSession,
    staleTime: 30_000,
    retry: false,
  });

  const retry = useMutation({
    mutationFn: async () => {
      const result = await retryProvision();
      if (!result.ok) throw new Error(result.error ?? "Cloud setup failed");
      return result;
    },
    onSuccess: async () => {
      toast.success("Cloud setup complete — this device now has a platform key");
      await queryClient.invalidateQueries({ queryKey: queryKeys.deusCloud.session });
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Cloud setup failed"),
  });

  const status = useQuery({
    queryKey: ["settings", "cloud"],
    queryFn: () => apiClient.get<CloudSettings>("/settings/cloud"),
    staleTime: 30_000,
    retry: false,
  });

  const saveToken = useMutation({
    mutationFn: (value: string) =>
      apiClient.post<{ ok: boolean }>("/settings/cloud/github-token", { token: value }),
    onSuccess: async () => {
      setToken("");
      toast.success("GitHub token saved — private repos now work in cloud workspaces");
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save token"),
  });

  const s = status.data;

  const agentConnected = (id: string) =>
    id === "codex" ? codexSub.data?.hasCodexSubscription : sub.data?.hasClaudeSubscription;

  // Repos the installed GitHub App cannot reach — drives the missing-access
  // list and, when empty, lets the App satisfy the repo-access step without a PAT.
  const accessible = new Set((githubApp.data?.accessibleRepos ?? []).map((r) => r.toLowerCase()));
  // Same parser the backend mints with (@shared/git-origin) — a looser one
  // here reported repos as uncovered, and demanded a PAT, for origin forms
  // provisioning handles fine (ssh://, www.github.com).
  const missingRepos = (localRepos.data ?? [])
    .map((r) => githubRepoSlug(r.git_origin_url ?? ""))
    .filter((slug): slug is string => slug !== null)
    .filter((slug) => !accessible.has(slug.toLowerCase()));
  const appCoversRepos =
    Boolean(githubApp.data?.installations.length) &&
    localRepos.data !== undefined &&
    missingRepos.length === 0;

  const step = (done: boolean | undefined, title: string) => (
    <h3 className="text-text-primary mb-1 flex items-center gap-2 text-sm font-medium">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          done
            ? "bg-accent-green/15 text-accent-green"
            : "border-border-subtle text-text-faint border border-dashed"
        )}
      >
        {done && <Check className="h-3 w-3" />}
      </span>
      {title}
    </h3>
  );

  const row = (label: string, ok: boolean | undefined, okText: string, missingText: string) => (
    <div className="border-border-subtle flex items-center justify-between border-b py-3 last:border-b-0">
      <span className="text-text-secondary text-sm">{label}</span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-sm",
          ok ? "text-accent-green" : "text-text-muted"
        )}
      >
        {ok && <Check className="h-3.5 w-3.5" />}
        {ok ? okText : missingText}
      </span>
    </div>
  );

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-text-primary mb-1 flex items-center gap-2 text-base font-semibold">
          <Cloud className="h-4 w-4" />
          Cloud setup{" "}
          <span className="text-text-muted text-sm font-normal">
            {
              [
                s?.enabled,
                s?.hasAnthropicKey ||
                  sub.data?.hasClaudeSubscription ||
                  codexSub.data?.hasCodexSubscription,
                s?.hasGithubToken || appCoversRepos,
              ].filter(Boolean).length
            }
            /3
          </span>
        </h2>
        <p className="text-text-muted text-sm">
          Cloud workspaces run in sandboxes on the Deus platform — the agent and files live
          remotely, and everything streams into the app.
        </p>
      </div>

      <div className="mb-8">
        {step(s?.enabled, "Deus Cloud account")}
        {row(
          "Connection",
          s?.enabled,
          s?.baseUrl ? `Connected · ${s.baseUrl.replace(/^https?:\/\//, "")}` : "Connected",
          session.data?.vaultLocked
            ? "Credentials are locked — unlock your keyring, then reopen Deus"
            : session.data?.signedIn
              ? "Signed in — device setup didn't finish"
              : "Not connected — sign in under Account"
        )}
        {/* Signed in with no platform key: provisioning runs after login, so
            its failure never reached the login result. Name it and offer the
            retry — "sign in under Account" is a dead end when the only button
            there is Sign out. */}
        {session.data?.signedIn && !s?.enabled && (
          <div className="border-border-subtle mt-2 flex items-start justify-between gap-3 rounded-lg border border-dashed px-3 py-2">
            <p className="text-text-muted text-xs">
              {session.data.platformKeyError ??
                "This device has no platform key yet, so cloud workspaces can't start."}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
            >
              {retry.isPending ? "Retrying…" : "Retry setup"}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-8">
        {/* Codex is deliberately NOT counted: the cloud lane only ships Claude
            credentials today, so a Codex-only setup would tick this step and
            then fail every cloud turn on a missing credential. */}
        {step(
          s?.hasAnthropicKey || sub.data?.hasClaudeSubscription,
          "Agents — run on your own subscriptions"
        )}
        <p className="text-text-muted mb-3 text-sm">
          Connect a personal plan and cloud agents bill it instead of an API key. Tokens are minted
          by you, in your terminal — Deus only stores the result (encrypted, streamed per turn,
          never visible to the agent).
        </p>
        <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
          {AGENT_SUBSCRIPTIONS.map((agent) => {
            const connected = agentConnected(agent.id);
            const open = openAgent === agent.id;
            return (
              <div key={agent.id}>
                <button
                  type="button"
                  disabled={!agent.available}
                  onClick={() => setOpenAgent(open ? null : agent.id)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left"
                  aria-expanded={open}
                >
                  <span className="text-text-primary text-sm font-medium">{agent.name}</span>
                  <span className="flex items-center gap-2">
                    {agent.available ? (
                      connected ? (
                        <span className="text-accent-green flex items-center gap-1.5 text-xs">
                          <Check className="h-3.5 w-3.5" /> Connected
                        </span>
                      ) : (
                        <span className="text-text-muted text-xs">Not connected</span>
                      )
                    ) : (
                      <span className="text-text-muted border-border-subtle rounded-full border border-dashed px-2 py-0.5 text-xs">
                        Coming soon
                      </span>
                    )}
                    {agent.available && (
                      <ChevronDown
                        className={cn(
                          "text-text-muted h-3.5 w-3.5 transition-transform duration-200",
                          open && "rotate-180"
                        )}
                      />
                    )}
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {open && agent.available && (
                    <m.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }
                      }
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-2 px-4 pb-3">
                        <p className="text-text-muted text-xs">{agent.instructions}</p>
                        {connected ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-start"
                            onClick={() =>
                              agent.id === "codex"
                                ? codexAction.mutate({ kind: "disconnect" })
                                : subAction.mutate({ kind: "disconnect" })
                            }
                            disabled={
                              agent.id === "codex" ? codexAction.isPending : subAction.isPending
                            }
                          >
                            Disconnect
                          </Button>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <code className="bg-surface-secondary text-text-secondary rounded px-2 py-1 text-xs">
                                {agent.command}
                              </code>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label="Copy command"
                                onClick={() => {
                                  void navigator.clipboard.writeText(agent.command ?? "");
                                  toast.success("Command copied");
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  const res = await openAgentSetupTerminal(agent.id);
                                  if (!res.ok) toast.error(res.error ?? "Could not open Terminal");
                                }}
                              >
                                <TerminalSquare className="mr-1.5 h-3.5 w-3.5" /> Open in Terminal
                              </Button>
                            </div>
                            {agent.kind === "paste" ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  aria-label={`${agent.name} subscription token`}
                                  type="password"
                                  value={subToken}
                                  onChange={(e) => setSubToken(e.target.value)}
                                  placeholder={agent.placeholder ?? ""}
                                  className="max-w-md text-sm"
                                  disabled={subAction.isPending}
                                />
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    subToken.trim() &&
                                    subAction.mutate({ kind: "paste", token: subToken.trim() })
                                  }
                                  disabled={!subToken.trim() || subAction.isPending}
                                >
                                  Save
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                className="self-start"
                                onClick={() => codexAction.mutate({ kind: "import" })}
                                disabled={codexAction.isPending}
                              >
                                {codexAction.isPending ? "Importing…" : "Import credential"}
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mb-2">
        {step(s?.hasGithubToken || appCoversRepos, "GitHub — repo access for sandboxes")}
        <p className="text-text-muted mb-3 text-sm">
          Sandboxes clone over https. The GitHub App mints short-lived, single-repo tokens
          server-side; a fine-grained personal access token is the fallback for anything it doesn't
          cover.
        </p>
        <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
          {/* Deus GitHub App row */}
          <div>
            <button
              type="button"
              onClick={() => setOpenGithub(openGithub === "app" ? null : "app")}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left"
              aria-expanded={openGithub === "app"}
            >
              <span className="text-text-primary text-sm font-medium">Deus GitHub App</span>
              <span className="flex items-center gap-2">
                {githubApp.data?.installations.length ? (
                  <span className="text-accent-green flex items-center gap-1.5 text-xs">
                    <Check className="h-3.5 w-3.5" /> Installed
                    {missingRepos.length > 0 && (
                      <span className="text-text-muted font-normal">
                        · {missingRepos.length} repo{missingRepos.length > 1 ? "s" : ""} missing
                      </span>
                    )}
                  </span>
                ) : githubApp.data?.configured ? (
                  <span className="text-text-muted text-xs">Not installed</span>
                ) : (
                  <span className="text-text-muted border-border-subtle rounded-full border border-dashed px-2 py-0.5 text-xs">
                    Awaiting App registration
                  </span>
                )}
                <ChevronDown
                  className={cn(
                    "text-text-muted h-3.5 w-3.5 transition-transform duration-200",
                    openGithub === "app" && "rotate-180"
                  )}
                />
              </span>
            </button>
            <AnimatePresence initial={false}>
              {openGithub === "app" && (
                <m.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }
                  }
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-2 px-4 pb-3">
                    <p className="text-text-muted text-xs">
                      {githubApp.data?.installations.length
                        ? `Installed for ${githubApp.data.installations.map((i) => i.accountLogin).join(", ")} — repo selection lives on GitHub.`
                        : "Install once, pick repos on GitHub — tokens are minted server-side and scoped to a single repository. Replaces the personal token."}
                    </p>
                    {githubApp.data?.installations.length && githubApp.data.appSlug ? (
                      <a
                        className="text-text-primary border-border-subtle hover:bg-surface-secondary self-start rounded-md border px-2.5 py-1 text-xs"
                        href={`https://github.com/apps/${githubApp.data.appSlug}/installations/new`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Manage repos ↗
                      </a>
                    ) : githubApp.data?.configured ? (
                      <Button
                        size="sm"
                        className="self-start"
                        onClick={async () => {
                          const res = await installGithubApp();
                          if (!res.ok) toast.error(res.error ?? "Could not start the install");
                          else toast.info("Complete the install on GitHub, then come back");
                        }}
                      >
                        Install
                      </Button>
                    ) : null}
                    {githubApp.data?.appSlug && missingRepos.length > 0 && (
                      <div>
                        <p className="text-text-muted mb-1 text-xs">Missing GitHub access</p>
                        {missingRepos.map((full) => (
                          <div
                            key={full}
                            className="border-border-subtle flex items-center justify-between border-b py-1.5 last:border-b-0"
                          >
                            <span className="text-text-secondary truncate text-sm">{full}</span>
                            <a
                              className="text-text-primary border-border-subtle hover:bg-surface-secondary ml-3 shrink-0 rounded-md border px-2.5 py-1 text-xs"
                              href={`https://github.com/apps/${githubApp.data.appSlug}/installations/new`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Install app ↗
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>

          {/* Personal access token row */}
          <div>
            <button
              type="button"
              onClick={() => setOpenGithub(openGithub === "pat" ? null : "pat")}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left"
              aria-expanded={openGithub === "pat"}
            >
              <span className="text-text-primary text-sm font-medium">Personal access token</span>
              <span className="flex items-center gap-2">
                {s?.hasGithubToken ? (
                  <span className="text-accent-green flex items-center gap-1.5 text-xs">
                    <Check className="h-3.5 w-3.5" /> Saved
                  </span>
                ) : (
                  <span className="text-text-muted text-xs">Not set</span>
                )}
                <ChevronDown
                  className={cn(
                    "text-text-muted h-3.5 w-3.5 transition-transform duration-200",
                    openGithub === "pat" && "rotate-180"
                  )}
                />
              </span>
            </button>
            <AnimatePresence initial={false}>
              {openGithub === "pat" && (
                <m.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }
                  }
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-2 px-4 pb-3">
                    <p className="text-text-muted text-xs">
                      Fine-grained token with contents read/write on the repos you'll use. Stored
                      encrypted on the Deus platform.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="GitHub token for private repositories"
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="github_pat_..."
                        className="max-w-md text-sm"
                        disabled={!s?.enabled || saveToken.isPending}
                      />
                      <Button
                        size="sm"
                        onClick={() => token.trim() && saveToken.mutate(token.trim())}
                        disabled={!s?.enabled || !token.trim() || saveToken.isPending}
                      >
                        {saveToken.isPending ? "Saving..." : s?.hasGithubToken ? "Replace" : "Save"}
                      </Button>
                    </div>
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
