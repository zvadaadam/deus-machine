import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, KeyRound, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import {
  type ClaudeSubscriptionState,
  connectClaudeSubscription,
  disconnectClaudeSubscription,
  getClaudeSubscriptionStatus,
  saveClaudeSubscriptionToken,
} from "@/platform/native/deus-cloud";

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
    mutationFn: async (
      action: { kind: "connect" | "disconnect" } | { kind: "paste"; token: string }
    ) => {
      const result: ClaudeSubscriptionState =
        action.kind === "connect"
          ? await connectClaudeSubscription()
          : action.kind === "paste"
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
          Cloud
        </h2>
        <p className="text-text-muted text-sm">
          Cloud workspaces run in sandboxes on the Deus platform — the agent and files live
          remotely, and everything streams into the app.
        </p>
      </div>

      <div className="mb-8">
        {row(
          "Connection",
          s?.enabled,
          s?.baseUrl ? `Connected · ${s.baseUrl.replace(/^https?:\/\//, "")}` : "Connected",
          "Not connected — sign in under Account"
        )}
        {row(
          "Claude credential (runs the agent)",
          s?.hasAnthropicKey || sub.data?.hasClaudeSubscription,
          sub.data?.hasClaudeSubscription ? "Connected via subscription" : "API key configured",
          "Missing"
        )}
        {row("GitHub token (private repos)", s?.hasGithubToken, "Configured", "Not set")}
      </div>

      <div className="mb-8">
        <h3 className="text-text-primary mb-1 flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-3.5 w-3.5" />
          Claude Code — cloud authentication
        </h3>
        <p className="text-text-muted mb-3 text-sm">
          Run cloud agents on your Claude Pro/Max subscription. Deus runs{" "}
          <code className="text-text-secondary">claude setup-token</code> for you — approve in the
          browser and the one-year token is stored encrypted on this device, streamed per turn,
          never visible to the agent.
        </p>
        {sub.data?.hasClaudeSubscription ? (
          <div className="flex items-center gap-3">
            <span className="text-accent-green flex items-center gap-1.5 text-sm">
              <Check className="h-3.5 w-3.5" /> Connected via subscription
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => subAction.mutate({ kind: "disconnect" })}
              disabled={subAction.isPending}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => subAction.mutate({ kind: "connect" })}
                disabled={subAction.isPending}
              >
                {subAction.isPending ? "Waiting for approval…" : "Connect subscription"}
              </Button>
              <span className="text-text-muted text-xs">
                or paste a token from <code>claude setup-token</code>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Claude subscription token"
                type="password"
                value={subToken}
                onChange={(e) => setSubToken(e.target.value)}
                placeholder="sk-ant-oat…"
                className="max-w-md text-sm"
                disabled={subAction.isPending}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  subToken.trim() && subAction.mutate({ kind: "paste", token: subToken.trim() })
                }
                disabled={!subToken.trim() || subAction.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="mb-2">
        <h3 className="text-text-primary mb-1 flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-3.5 w-3.5" />
          GitHub token for private repos
        </h3>
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
