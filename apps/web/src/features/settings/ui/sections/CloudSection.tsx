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
  getClaudeSubscriptionStatus,
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
    command: "claude setup-token",
    placeholder: "sk-ant-oat…",
    instructions:
      "Run this in a terminal, approve in the browser, then paste the token it prints. One-year token, stored encrypted, streamed per turn — the cloud agent never sees it.",
  },
  {
    id: "codex",
    name: "Codex",
    available: false,
    command: null,
    placeholder: null,
    instructions:
      "ChatGPT subscription auth is a device-code flow: enable device authorization in ChatGPT security settings, then approve a code per cloud environment (OpenAI allows one credential seat per sandbox). Ships with Codex cloud support.",
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
                s?.hasAnthropicKey || sub.data?.hasClaudeSubscription,
                s?.hasGithubToken,
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
          s?.hasAnthropicKey || sub.data?.hasClaudeSubscription,
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
                  sub.data?.hasClaudeSubscription ? (
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
                (sub.data?.hasClaudeSubscription ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => subAction.mutate({ kind: "disconnect" })}
                    disabled={subAction.isPending}
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
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="border-border-subtle mb-3 flex items-center justify-between rounded-lg border border-dashed px-4 py-3">
          <div>
            <span className="text-text-primary text-sm font-medium">Deus GitHub App</span>
            <p className="text-text-muted mt-0.5 text-xs">
              Install once, per-repo access, tokens minted server-side and scoped to a single
              repository — replaces the token below. Recommended when it ships.
            </p>
          </div>
          <span className="text-text-muted border-border-subtle rounded-full border border-dashed px-2 py-0.5 text-xs">
            Coming soon
          </span>
        </div>
        {step(s?.hasGithubToken, "GitHub — repo access for sandboxes")}
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
