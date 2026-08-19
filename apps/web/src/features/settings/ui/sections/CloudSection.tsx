import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";

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
          "Not configured — set DEUS_CLOUD_AGNT_API_KEY"
        )}
        {row("Anthropic key (runs the agent)", s?.hasAnthropicKey, "Configured", "Missing")}
        {row("GitHub token (private repos)", s?.hasGithubToken, "Configured", "Not set")}
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
