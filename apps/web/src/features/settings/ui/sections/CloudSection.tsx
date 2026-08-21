import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, Copy, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import {
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
  const [token, setToken] = useState("");
  const [subToken, setSubToken] = useState("");

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
  const missingRepos = (localRepos.data ?? [])
    .map((r) => r.git_origin_url ?? "")
    .filter((u) => u.includes("github.com"))
    .map((u) =>
      u
        .replace(/^git@github\.com:/, "")
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\.git$/, "")
    )
    .filter((full) => full.includes("/") && !accessible.has(full.toLowerCase()));
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
          "Not connected — sign in under Account"
        )}
      </div>

      <div className="mb-8">
        {step(
          s?.hasAnthropicKey ||
            sub.data?.hasClaudeSubscription ||
            codexSub.data?.hasCodexSubscription,
          "Agents — run on your own subscriptions"
        )}
        <p className="text-text-muted mb-3 text-sm">
          Connect a personal plan and cloud agents bill it instead of an API key. Tokens are minted
          by you, in your terminal — Deus only stores the result (encrypted, streamed per turn,
          never visible to the agent).
        </p>
        <div className="flex flex-col gap-3">
          {AGENT_SUBSCRIPTIONS.map((agent) => (
            <div key={agent.id} className="border-border-subtle rounded-lg border px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-text-primary text-sm font-medium">{agent.name}</span>
                {agent.available ? (
                  agentConnected(agent.id) ? (
                    <span className="text-accent-green flex items-center gap-1.5 text-sm">
                      <Check className="h-3.5 w-3.5" /> Connected via subscription
                    </span>
                  ) : (
                    <span className="text-text-muted text-xs">Not connected</span>
                  )
                ) : (
                  <span className="text-text-muted border-border-subtle rounded-full border border-dashed px-2 py-0.5 text-xs">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="text-text-muted mt-1 text-xs">{agent.instructions}</p>
              {agent.available &&
                (agentConnected(agent.id) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
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
                  <div className="mt-2 flex flex-col gap-2">
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
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div
          className={cn(
            "border-border-subtle mb-3 flex items-center justify-between rounded-lg border px-4 py-3",
            !githubApp.data?.configured && "border-dashed"
          )}
        >
          <div>
            <span className="text-text-primary text-sm font-medium">Deus GitHub App</span>
            <p className="text-text-muted mt-0.5 text-xs">
              {githubApp.data?.installations.length
                ? `Installed for ${githubApp.data.installations.map((i) => i.accountLogin).join(", ")} — sandboxes get server-minted tokens scoped to one repo.`
                : "Install once, per-repo access, tokens minted server-side and scoped to a single repository — replaces the token below."}
            </p>
          </div>
          {githubApp.data?.installations.length ? (
            <span className="flex shrink-0 items-center gap-3">
              <span className="text-accent-green flex items-center gap-1.5 text-sm">
                <Check className="h-3.5 w-3.5" /> Installed
              </span>
              {githubApp.data.appSlug && (
                <a
                  className="text-text-primary border-border-subtle hover:bg-surface-secondary rounded-md border px-2.5 py-1 text-xs"
                  href={`https://github.com/apps/${githubApp.data.appSlug}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage repos ↗
                </a>
              )}
            </span>
          ) : githubApp.data?.configured ? (
            <Button
              size="sm"
              className="shrink-0"
              onClick={async () => {
                const res = await installGithubApp();
                if (!res.ok) toast.error(res.error ?? "Could not start the install");
                else toast.info("Complete the install on GitHub, then come back");
              }}
            >
              Install
            </Button>
          ) : (
            <span className="text-text-muted border-border-subtle shrink-0 rounded-full border border-dashed px-2 py-0.5 text-xs">
              Awaiting App registration
            </span>
          )}
        </div>
        {(() => {
          const state = githubApp.data;
          if (!state?.installations.length || !state.appSlug) return null;
          if (missingRepos.length === 0) return null;
          return (
            <div className="mb-3">
              <p className="text-text-muted mb-1 text-xs">Missing GitHub access</p>
              {missingRepos.map((full) => (
                <div
                  key={full}
                  className="border-border-subtle flex items-center justify-between border-b py-2 last:border-b-0"
                >
                  <span className="text-text-secondary truncate text-sm">{full}</span>
                  <a
                    className="text-text-primary border-border-subtle hover:bg-surface-secondary ml-3 shrink-0 rounded-md border px-2.5 py-1 text-xs"
                    href={`https://github.com/apps/${state.appSlug}/installations/new`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Install app ↗
                  </a>
                </div>
              ))}
            </div>
          );
        })()}
        {step(s?.hasGithubToken || appCoversRepos, "GitHub — repo access for sandboxes")}
        <p className="text-text-muted mb-3 text-sm">
          Sandboxes clone over https. A fine-grained personal access token (contents read/write on
          the repos you'll use) lets cloud workspaces clone and push private repositories. Stored
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
    </div>
  );
}
