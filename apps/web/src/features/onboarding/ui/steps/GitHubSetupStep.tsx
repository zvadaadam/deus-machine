import { toast } from "sonner";
import { useStartGhAuthLogin } from "../../api";
import { useGhStatus } from "@/features/workspace/api";
import { CliStatusRow } from "../components/CliStatusRow";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";

interface GitHubSetupStepProps {
  onNext: () => void;
  onBack: () => void;
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

export function GitHubSetupStep({ onNext, onBack }: GitHubSetupStepProps) {
  const ghStatus = useGhStatus();
  const ghAuthLogin = useStartGhAuthLogin();

  const installed = ghStatus.data?.isInstalled;
  const authenticated = ghStatus.data?.isAuthenticated === true;
  const login = ghStatus.data?.login ?? null;
  const displayName = ghStatus.data?.displayName ?? null;
  const avatarUrl = ghStatus.data?.avatarUrl ?? null;
  const profileUrl = ghStatus.data?.htmlUrl ?? (login ? `https://github.com/${login}` : null);

  const cliAvailable = ghStatus.isLoading ? null : (installed ?? false);
  const checkingAccount = cliAvailable === true && (ghStatus.isLoading || ghAuthLogin.isPending);
  const connectionStatus =
    cliAvailable === null || checkingAccount ? null : cliAvailable === true && authenticated;
  const canSignIn = cliAvailable === true && !ghStatus.isLoading && !authenticated;
  const ghAuthActionLabel = canSignIn
    ? ghAuthLogin.isPending
      ? "Signing in"
      : "Sign in"
    : undefined;

  async function retryGitHubChecks(): Promise<void> {
    await ghStatus.refetch();
  }

  async function signInWithGitHubCli(): Promise<void> {
    const result = await ghAuthLogin.mutateAsync();
    if (!result.success) {
      toast.error(result.error ?? "GitHub sign-in did not complete");
      return;
    }

    const refreshed = await ghStatus.refetch();
    if (refreshed.data?.isAuthenticated) {
      toast.success("GitHub connected");
    } else {
      toast.error("GitHub sign-in finished, but Deus could not verify it yet");
    }
  }

  function getDetail(): string {
    if (ghStatus.data && installed === false) {
      return "Bundled GitHub CLI is unavailable";
    }
    if (ghStatus.isLoading) return "Checking authentication...";
    if (ghAuthLogin.isPending) return "Complete sign-in in your browser";
    return "Not connected";
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-white">Connect GitHub</h2>
        <p className="text-sm text-white/50">
          Sign in to create branches and pull requests from your workspaces.
        </p>
      </div>

      {authenticated && login && profileUrl ? (
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open @${login} on GitHub`}
          className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3 transition-colors duration-150 hover:bg-white/[0.07]"
        >
          <div className="relative shrink-0">
            <Avatar className="size-10">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName || login} />}
              <AvatarFallback className="bg-white/10 text-xs font-semibold text-white">
                {getInitials(displayName, login)}
              </AvatarFallback>
            </Avatar>
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-white text-black ring-2 ring-black"
            >
              <GitHubIcon className="size-2.5" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{displayName || login}</p>
            <p className="truncate text-xs text-white/50">
              {displayName ? `@${login}` : "Signed in to GitHub"}
            </p>
          </div>
        </a>
      ) : (
        <CliStatusRow
          name="GitHub account"
          description="Used for pull requests and GitHub workspaces"
          installed={connectionStatus}
          detail={getDetail()}
          actionLabel={ghAuthActionLabel}
          actionIcon={<GitHubIcon className="h-3 w-3" />}
          actionBusy={ghAuthLogin.isPending}
          actionDisabled={!canSignIn}
          onAction={canSignIn ? () => void signInWithGitHubCli() : undefined}
          onRetry={() => void retryGitHubChecks()}
          retryLabel="Check again"
          showRetry={cliAvailable === false}
          retryWhenUnavailable={cliAvailable === false}
        />
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onBack}
          className="rounded-xl px-6 py-2.5 text-sm font-medium text-white/50 transition-colors duration-200 hover:text-white/80"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          onClick={onNext}
          className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:bg-white/15 hover:text-white"
        >
          Skip
        </button>
        {authenticated && (
          <button
            onClick={onNext}
            className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
