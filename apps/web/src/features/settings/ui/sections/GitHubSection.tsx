import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CheckCircle2,
  Github,
  Loader2,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";
import { cn } from "@/shared/lib/utils";
import { useGhStatus } from "@/features/workspace/api";

function GitHubStatusBadge({
  installed,
  authenticated,
  loading,
}: {
  installed: boolean | undefined;
  authenticated: boolean | undefined;
  loading: boolean;
}) {
  if (loading) {
    return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Checking" />;
  }
  if (installed === false) {
    return <XCircle className="text-muted-foreground size-4" aria-label="Unavailable" />;
  }
  if (authenticated) {
    return <CheckCircle2 className="text-success size-4" aria-label="Connected" />;
  }
  return <XCircle className="text-muted-foreground size-4" aria-label="Not connected" />;
}

function getCliLocation(path: string | null | undefined): { label: string; path: string } | null {
  if (!path) return null;

  const normalizedPath = path.replaceAll("\\", "/");
  const isBundled =
    normalizedPath.includes("/Contents/Resources/bin/") ||
    normalizedPath.includes("/dist/runtime/electron/bin/");

  // Bundled gh is the default — no need to surface it in the UI.
  if (isBundled) return null;

  return { label: "Using system GitHub CLI.", path };
}

function getInitials(displayName: string | null, login: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return displayName.slice(0, 2).toUpperCase();
  }
  if (login) return login.slice(0, 2).toUpperCase();
  return "GH";
}

export function GitHubSection() {
  const queryClient = useQueryClient();
  const ghStatus = useGhStatus();
  const ghCli = useQuery({
    queryKey: ["settings", "github", "cli-check"],
    queryFn: () => native.cli.checkCliTool("gh"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const signInMutation = useMutation({
    mutationFn: () => native.cli.startGhAuthLogin(),
    onSuccess: async (result) => {
      if (!result.success) {
        toast.error(result.error ?? "GitHub sign-in did not complete");
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.github.ghStatus });
      const refreshed = await ghStatus.refetch();
      if (refreshed.data?.isAuthenticated) {
        toast.success("GitHub connected");
      } else {
        toast.error("GitHub sign-in finished, but Deus could not verify it yet");
      }
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => native.cli.logoutGhAuth(),
    onSuccess: async (result) => {
      if (!result.success) {
        toast.error(result.error ?? "GitHub sign-out did not complete");
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.github.ghStatus });
      const refreshed = await ghStatus.refetch();
      if (refreshed.data?.isAuthenticated) {
        toast.error("GitHub signed out, but Deus still sees an active account");
      } else {
        toast.success("GitHub signed out");
      }
    },
  });

  const checking = ghStatus.isLoading || ghCli.isLoading;
  const refreshing = ghStatus.isFetching || ghCli.isFetching;
  const installed = ghCli.data?.installed ?? ghStatus.data?.isInstalled;
  const webMode = ghCli.data?.webMode === true;
  const authenticated = ghStatus.data?.isAuthenticated === true;
  const username = ghStatus.data?.login ?? null;
  const displayName = ghStatus.data?.displayName ?? null;
  const avatarUrl = ghStatus.data?.avatarUrl ?? null;
  const profileUrl = ghStatus.data?.htmlUrl ?? (username ? `https://github.com/${username}` : null);
  const cliLocation = getCliLocation(ghCli.data?.path);
  const authMutationPending = signInMutation.isPending || signOutMutation.isPending;
  const canSignIn = installed === true && !authenticated && !authMutationPending;
  const canSignOut = authenticated && !authMutationPending;

  async function refreshStatus() {
    await Promise.all([ghCli.refetch(), ghStatus.refetch()]);
  }

  // Re-check on mount so the section reflects external changes (e.g. signing
  // out via terminal) without the user clicking refresh.
  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOutOfGitHub(): Promise<void> {
    const confirmed = await native.dialog.confirm(
      "Sign out of GitHub CLI?",
      `This removes the local GitHub CLI authentication for ${
        username ?? "the active GitHub account"
      } on this Mac. It can also affect gh in Terminal.`
    );
    if (!confirmed) return;

    await signOutMutation.mutateAsync();
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">GitHub</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Manage the GitHub account used for pull requests, branches, and GitHub workspaces.
        </p>
      </div>

      <div className="border-border-subtle group/card space-y-4 rounded-lg border p-5">
        <div className="flex items-start justify-between gap-4">
          {authenticated && username && profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open @${username} on GitHub`}
              className="hover:bg-foreground/[0.04] -m-1 flex min-w-0 items-center gap-3 rounded-md p-1 transition-colors"
            >
              <div className="relative shrink-0">
                <Avatar className="size-10">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName || username} />}
                  <AvatarFallback className="text-xs font-semibold">
                    {getInitials(displayName, username)}
                  </AvatarFallback>
                </Avatar>
                <span
                  aria-hidden="true"
                  className="bg-bg-surface ring-bg-surface text-text-primary absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full ring-2"
                >
                  <svg viewBox="0 0 16 16" className="size-2.5 fill-current">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{displayName || username}</p>
                <p className="text-muted-foreground flex items-center gap-0.5 truncate text-xs">
                  <span className="truncate">{displayName ? `@${username}` : "View profile"}</span>
                  <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                </p>
              </div>
            </a>
          ) : (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">GitHub account</p>
              </div>
              <p className="text-muted-foreground mt-0.5 text-sm">
                {checking
                  ? "Checking GitHub status."
                  : webMode
                    ? "Use Deus desktop to connect GitHub."
                    : installed === false
                      ? "Bundled GitHub CLI is unavailable. Restart Deus, then check again."
                      : signInMutation.isPending
                        ? "Complete sign-in in your browser."
                        : "Connect GitHub to enable pull requests and GitHub workspaces."}
              </p>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-1">
            {authenticated ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-text-primary size-8"
                    disabled={authMutationPending}
                    aria-label="GitHub account actions"
                  >
                    {authMutationPending || refreshing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <MoreHorizontal className="size-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem
                    onClick={() => void refreshStatus()}
                    disabled={refreshing || authMutationPending}
                  >
                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                    Re-check status
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => void signOutOfGitHub()}
                    disabled={!canSignOut}
                    variant="destructive"
                  >
                    <LogOut className="size-3.5" />
                    {signOutMutation.isPending ? "Signing out" : "Sign out"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <GitHubStatusBadge
                installed={installed}
                authenticated={authenticated}
                loading={checking || authMutationPending}
              />
            )}
          </div>
        </div>

        {cliLocation && (
          <p className="text-muted-foreground truncate text-xs">
            {cliLocation.label}
            <span className="font-mono"> {cliLocation.path}</span>
          </p>
        )}

        {installed === false && !webMode ? (
          <>
            <Separator />
            <Button
              variant="outline"
              size="sm"
              className="w-fit gap-1.5"
              onClick={() => void refreshStatus()}
              disabled={refreshing || authMutationPending}
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Check again
            </Button>
          </>
        ) : installed === false || authenticated ? null : (
          <>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">github.com account</p>
                <p className="text-muted-foreground text-sm">Sign in with your GitHub account.</p>
              </div>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => void signInMutation.mutateAsync()}
                disabled={!canSignIn}
              >
                {signInMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Github className="size-3.5" />
                )}
                {signInMutation.isPending ? "Signing in" : "Sign in"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
