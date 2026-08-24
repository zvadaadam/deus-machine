import { useState } from "react";
import type { ReactNode } from "react";
import { githubRepoSlug } from "@shared/git-origin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, Cloud, Copy, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/queryKeys";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useRepos } from "@/features/repository";
import { githubAppBlockedLabel } from "../../lib/github-app-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import {
  retryProvision,
  type ClaudeSubscriptionState,
  disconnectClaudeSubscription,
  disconnectCodexSubscription,
  getClaudeSubscriptionStatus,
  getCodexSubscriptionStatus,
  getGithubAppStatus,
  importCodexAuth,
  startCodexLogin,
  installGithubApp,
  openAgentSetupTerminal,
  saveClaudeSubscriptionToken,
} from "@/platform/native/deus-cloud";

/**
 * Agent subscription setups. One entry per agent; a new agent also needs its
 * mint command in the main-process registry, a credential slot, and wiring in
 * agentConnected/the action mutations below.
 */
const AGENT_SUBSCRIPTIONS = [
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "paste" as const,
    command: "claude setup-token",
    placeholder: "sk-ant-oat…",
    instructions:
      "Run this in a terminal, approve in the browser, then paste the token it prints. One-year token, stored encrypted, streamed per turn — the cloud agent never sees it.",
  },
  {
    id: "codex",
    name: "Codex",
    kind: "import" as const,
    command: "codex login --device-auth",
    placeholder: null,
    instructions:
      "Sign in opens your browser on your ChatGPT account — the codex CLI owns the whole exchange and Deus imports the credential it writes. Stored encrypted, resolved per turn server-side. The command above is the manual fallback (device-auth) for headless machines.",
  },
] as const;

interface CloudSettings {
  hasTurnCredential?: boolean;
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
    mutationFn: async (action: { kind: "login" } | { kind: "import" } | { kind: "disconnect" }) => {
      const result =
        action.kind === "login"
          ? await startCodexLogin()
          : action.kind === "import"
            ? await importCodexAuth()
            : await disconnectCodexSubscription();
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: async (result) => {
      toast.success(
        result.hasCodexSubscription
          ? "Codex connected — cloud sandboxes can run Codex on your plan"
          : "Codex subscription disconnected"
      );
      await queryClient.invalidateQueries({ queryKey: ["settings", "codex-subscription"] });
      // hasTurnCredential (checklist + send-gating) folds Codex in — same
      // pairing the Claude action below does.
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
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

  // useRepos, not a local query: an inline ["repos"] key collided with
  // queryKeys.repos.all — same cache entry, different transport and
  // staleTime, last observer wins.
  const localRepos = useRepos();

  const githubApp = useQuery({
    queryKey: ["settings", "github-app"],
    queryFn: getGithubAppStatus,
    staleTime: 30_000,
    // Deliberate override of the global focus-refetch OFF: this state
    // changes on GitHub in another tab BY DESIGN (install, manage repos,
    // uninstall), and any return to the app should pick it up — a per-click
    // listener missed every path but the Install button (the "Install app"
    // links beside missing repos, most notably).
    refetchOnWindowFocus: true,
    retry: false,
  });

  const session = useDeusCloudSession();

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

  // ONE derivation for the header counter and the step tick — they were
  // written twice and disagreed about Codex (which the cloud lane cannot
  // run, so a Codex-only setup must not tick this).
  // hasTurnCredential is the backend's full disjunction (API key, pushed
  // token, either canonical platform secret) — a second device in the same
  // org has runnable turns with an empty local vault. The local subscription
  // flags still count for the pre-push moment right after connecting; Codex
  // counts since the sandbox runs codex-app-server.
  const agentsDone =
    s?.hasTurnCredential || sub.data?.hasClaudeSubscription || codexSub.data?.hasCodexSubscription;

  const agentConnected = (id: string) =>
    id === "codex" ? codexSub.data?.hasCodexSubscription : sub.data?.hasClaudeSubscription;

  // Repos the installed GitHub App cannot reach — drives the missing-access
  // list and, when empty, lets the App satisfy the repo-access step without a PAT.
  // null = the repos lookup failed. Unknown coverage claims nothing: no
  // missing-repos list, no ticked step.
  const coverageKnown = Array.isArray(githubApp.data?.accessibleRepos);
  const accessible = new Set((githubApp.data?.accessibleRepos ?? []).map((r) => r.toLowerCase()));
  // Same parser the backend mints with (@shared/git-origin) — a looser one
  // here reported repos as uncovered, and demanded a PAT, for origin forms
  // provisioning handles fine (ssh://, www.github.com).
  const missingRepos = coverageKnown
    ? (localRepos.data ?? [])
        .map((r) => githubRepoSlug(r.git_origin_url ?? ""))
        .filter((slug): slug is string => slug !== null)
        .filter((slug) => !accessible.has(slug.toLowerCase()))
    : [];

  /**
   * One accordion row. The header/scaffold existed three times byte-identical
   * (agents, GitHub App, PAT) — and per-row drift in copies like these is where
   * this branch's truthfulness bugs kept starting.
   */
  function DisclosureRow({
    title,
    status,
    open,
    onToggle,
    children,
  }: {
    title: string;
    status: ReactNode;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
  }) {
    const reducedMotion = useReducedMotion();
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left"
          aria-expanded={open}
        >
          <span className="text-text-primary text-sm font-medium">{title}</span>
          <span className="flex items-center gap-2">
            {status}
            <ChevronDown
              className={cn(
                "text-text-muted h-3.5 w-3.5 transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <m.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={
                reducedMotion ? { duration: 0 } : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }
              }
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-2 px-4 pb-3">{children}</div>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  const appCoversRepos =
    Boolean(githubApp.data?.installations.length) &&
    coverageKnown &&
    (localRepos.data?.length ?? 0) > 0 &&
    missingRepos.length === 0;

  const step = (done: boolean | undefined, title: string) => (
    <h3 className="text-text-primary mb-1 flex items-center gap-2 text-sm font-medium">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          done
            ? "bg-accent-green/15 text-accent-green"
            : "border-border-subtle border border-dashed"
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
            {[s?.enabled, agentsDone, s?.hasGithubToken || appCoversRepos].filter(Boolean).length}
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
          status.isLoading
            ? "Checking…"
            : status.isError
              ? "Can't reach the Deus backend"
              : session.data?.vaultLocked
                ? "Credentials are locked — unlock your keyring, then reopen Deus"
                : session.data?.signedIn
                  ? "Signed in — device setup didn't finish"
                  : "Not connected — sign in under Account"
        )}
        {/* Signed in with no platform key: provisioning runs after login, so
            its failure never reached the login result. Name it and offer the
            retry — "sign in under Account" is a dead end when the only button
            there is Sign out. */}
        {session.data?.signedIn && status.isSuccess && !s?.enabled && (
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
        {step(agentsDone, "Agents — run on your own subscriptions")}
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
              <DisclosureRow
                key={agent.id}
                title={agent.name}
                status={
                  connected ? (
                    <span className="text-accent-green flex items-center gap-1.5 text-xs">
                      <Check className="h-3.5 w-3.5" /> Connected
                    </span>
                  ) : (
                    <span className="text-text-muted text-xs">Not connected</span>
                  )
                }
                open={open}
                onToggle={() => setOpenAgent(open ? null : agent.id)}
              >
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
                    disabled={agent.id === "codex" ? codexAction.isPending : subAction.isPending}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <code className="bg-muted text-text-secondary rounded px-2 py-1 text-xs">
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
                      <div className="flex items-center gap-2">
                        {/* One click: main spawns the bundled `codex login`
                            (browser OAuth, no device codes) and imports the
                            credential it writes. The manual command above
                            stays as the fallback for headless setups. */}
                        <Button
                          size="sm"
                          className="self-start"
                          onClick={() => codexAction.mutate({ kind: "login" })}
                          disabled={codexAction.isPending}
                        >
                          {codexAction.isPending ? "Waiting for browser…" : "Sign in with ChatGPT"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => codexAction.mutate({ kind: "import" })}
                          disabled={codexAction.isPending}
                        >
                          Import existing
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </DisclosureRow>
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
          <DisclosureRow
            title="Deus GitHub App"
            status={
              githubApp.data?.installations.length ? (
                <span className="text-accent-green flex items-center gap-1.5 text-xs">
                  <Check className="h-3.5 w-3.5" /> Installed
                  {githubApp.isSuccess && missingRepos.length > 0 && (
                    <span className="text-text-muted font-normal">
                      · {missingRepos.length} repo{missingRepos.length > 1 ? "s" : ""} missing
                    </span>
                  )}
                </span>
              ) : githubApp.data?.configured ? (
                <span className="text-text-muted text-xs">Not installed</span>
              ) : (
                <span className="text-text-muted border-border-subtle rounded-full border border-dashed px-2 py-0.5 text-xs">
                  {githubAppBlockedLabel(githubApp.data)}
                </span>
              )
            }
            open={openGithub === "app"}
            onToggle={() => setOpenGithub(openGithub === "app" ? null : "app")}
          >
            <p className="text-text-muted text-xs">
              {githubApp.data?.installations.length
                ? `Installed for ${githubApp.data.installations.map((i) => i.accountLogin).join(", ")} — repo selection lives on GitHub.`
                : "Install once, pick repos on GitHub — tokens are minted server-side and scoped to a single repository. Replaces the personal token."}
            </p>
            {githubApp.data?.installations.length && githubApp.data.appSlug ? (
              <a
                className="text-text-primary border-border-subtle hover:bg-bg-muted self-start rounded-md border px-2.5 py-1 text-xs"
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
                  if (!res.ok) {
                    toast.error(res.error ?? "Could not start the install");
                    return;
                  }
                  toast.info("Complete the install on GitHub, then come back");
                }}
              >
                Install
              </Button>
            ) : (
              <p className="text-text-muted text-xs">{githubAppBlockedLabel(githubApp.data)}</p>
            )}
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
                      className="text-text-primary border-border-subtle hover:bg-bg-muted ml-3 shrink-0 rounded-md border px-2.5 py-1 text-xs"
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
          </DisclosureRow>

          <DisclosureRow
            title="Personal access token"
            status={
              s?.hasGithubToken ? (
                <span className="text-accent-green flex items-center gap-1.5 text-xs">
                  <Check className="h-3.5 w-3.5" /> Saved
                </span>
              ) : (
                <span className="text-text-muted text-xs">Not set</span>
              )
            }
            open={openGithub === "pat"}
            onToggle={() => setOpenGithub(openGithub === "pat" ? null : "pat")}
          >
            <p className="text-text-muted text-xs">
              Fine-grained token with contents read/write on the repos you'll use. Stored encrypted
              on the Deus platform.
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
          </DisclosureRow>
        </div>
      </div>
    </div>
  );
}
