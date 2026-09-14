import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { githubRepoSlug } from "@shared/git-origin";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRepos } from "@/features/repository";
import { getGithubAppStatus, installGithubApp } from "@/platform/native/deus-cloud";
import { apiClient } from "@/shared/api/client";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { uiActions } from "@/shared/stores/uiStore";
import { githubAppBlockedLabel } from "../../lib/github-app-label";

/** GitHub App installation and its optional PAT fallback have one settings owner. */
export function GithubCloudAccess() {
  const queryClient = useQueryClient();
  const signIn = useDeusCloudSignIn();
  const cloud = useCloudSettings();
  const repos = useRepos();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const app = useQuery({
    queryKey: ["settings", "github-app"],
    queryFn: getGithubAppStatus,
    staleTime: 30_000,
    // Installation/repository selection happens in a different browser tab.
    refetchOnWindowFocus: true,
    retry: false,
  });
  const install = useMutation({
    mutationFn: async () => {
      const result = await installGithubApp();
      if (!result.ok) throw new Error(result.error ?? "Could not open GitHub");
    },
    onSuccess: () => toast.info("Choose repositories on GitHub, then come back to Deus"),
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const data = app.data;
  const failed = app.isError || !!data?.error;
  const managementUrl = data?.appSlug
    ? `https://github.com/apps/${data.appSlug}/installations/new`
    : undefined;
  const accessible = new Set(data?.accessibleRepos?.map((repo) => repo.toLowerCase()));
  const missingRepos = data?.accessibleRepos
    ? [
        ...new Set((repos.data ?? []).map((repo) => githubRepoSlug(repo.git_origin_url ?? ""))),
      ].filter((repo): repo is string => repo !== null && !accessible.has(repo.toLowerCase()))
    : [];

  async function saveToken() {
    if (!token.trim() || saving) return;
    setSaving(true);
    try {
      // Credential values must not be retained in the Query mutation cache.
      await apiClient.post("/settings/cloud/github-token", { token: token.trim() });
      setToken("");
      toast.success("GitHub token saved");
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="github-cloud-heading">
      <div>
        <h4 id="github-cloud-heading" className="text-sm font-medium">
          Cloud repositories
        </h4>
        <p className="text-muted-foreground mt-1 text-sm">
          Install the Deus GitHub App and choose the repositories your cloud workspaces can use.
        </p>
      </div>
      <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Deus GitHub App</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {app.isPending
                ? "Checking installation…"
                : failed
                  ? "Couldn't check GitHub access."
                  : data?.installations.length
                    ? `Installed for ${data.installations.map((item) => item.accountLogin).join(", ")}`
                    : data?.configured
                      ? "Choose which repositories Deus can access."
                      : githubAppBlockedLabel(data)}
            </p>
          </div>
          {failed ? (
            <Button variant="outline" size="sm" onClick={() => void app.refetch()}>
              Try again
            </Button>
          ) : app.isPending ? null : data?.installations.length && managementUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={managementUrl} target="_blank" rel="noopener noreferrer">
                Manage repositories
              </a>
            </Button>
          ) : data?.configured ? (
            <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
              {install.isPending ? "Opening…" : "Install app"}
            </Button>
          ) : !data?.signedIn ? (
            <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
              {signIn.isPending ? "Waiting for browser…" : "Sign in to Deus Cloud"}
            </Button>
          ) : null}
        </div>
        {missingRepos.length > 0 && managementUrl && (
          <div className="p-4">
            <p className="text-muted-foreground mb-2 text-sm">
              Repositories that still need access
            </p>
            <ul className="space-y-2">
              {missingRepos.map((repo) => (
                <li key={repo} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{repo}</span>
                  <a
                    className="shrink-0 underline underline-offset-4"
                    href={managementUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Grant access
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Personal access token{" "}
            <span className="text-muted-foreground font-normal">
              · {cloud.data?.hasGithubToken ? "Saved" : "Optional"}
            </span>
          </summary>
          <p className="text-muted-foreground mt-3 text-sm">
            Use a fine-grained token when you can't use the GitHub App. Give it contents read/write
            access to the repositories you need.
          </p>
          {!cloud.data?.enabled && (
            <Button
              className="mt-2"
              variant="outline"
              size="sm"
              onClick={() => uiActions.setActiveSettingsSection("cloud")}
            >
              Connect Deus Cloud
            </Button>
          )}
          <form
            className="mt-3 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveToken();
            }}
          >
            <Label htmlFor="cloud-github-token">GitHub token</Label>
            <div className="flex items-center gap-2">
              <Input
                id="cloud-github-token"
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="github_pat_…"
                disabled={!cloud.data?.enabled || saving}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!cloud.data?.enabled || !token.trim() || saving}
              >
                {saving ? "Saving…" : cloud.data?.hasGithubToken ? "Replace" : "Save"}
              </Button>
            </div>
          </form>
        </details>
      </div>
    </section>
  );
}
