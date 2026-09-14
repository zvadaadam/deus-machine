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
    try {
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GitHub sign-in failed");
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
        <h2 className="text-onboarding-foreground text-2xl font-semibold">Connect GitHub</h2>
        <p className="text-onboarding-foreground/50 text-sm">
          Sign in to create branches and pull requests from your workspaces.
        </p>
      </div>

      {authenticated && login && profileUrl ? (
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open @${login} on GitHub`}
          className="bg-onboarding-foreground/5 hover:bg-onboarding-foreground/[0.07] flex items-center gap-3 rounded-xl px-4 py-3 transition-colors duration-150"
        >
          <div className="relative shrink-0">
            <Avatar className="size-10">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName || login} />}
              <AvatarFallback className="bg-onboarding-foreground/10 text-onboarding-foreground text-xs font-semibold">
                {getInitials(displayName, login)}
              </AvatarFallback>
            </Avatar>
            <span
              aria-hidden="true"
              className="bg-onboarding-foreground text-onboarding-contrast ring-onboarding-contrast absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full ring-2"
            >
              <GitHubIcon className="size-2.5" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-onboarding-foreground truncate text-sm font-medium">
              {displayName || login}
            </p>
            <p className="text-onboarding-foreground/50 truncate text-xs">
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
          className="control-interaction text-onboarding-foreground/50 hover:text-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-normal"
        >
          Back
        </button>
        <div className="flex-1" />
        {!authenticated && (
          <button
            onClick={onNext}
            className="control-interaction bg-onboarding-foreground/10 text-onboarding-foreground/70 hover:bg-onboarding-foreground/15 hover:text-onboarding-foreground rounded-lg px-6 py-2.5 text-sm font-normal"
          >
            Skip
          </button>
        )}
        {authenticated && (
          <button
            onClick={onNext}
            className="control-interaction bg-onboarding-foreground text-onboarding-contrast hover:bg-onboarding-foreground/90 active:bg-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-medium"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
