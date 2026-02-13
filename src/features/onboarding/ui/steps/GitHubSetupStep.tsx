import { useCliCheck, useGhAuth } from "../../api";
import { CliStatusRow } from "../components/CliStatusRow";

interface GitHubSetupStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function GitHubSetupStep({ onNext, onBack }: GitHubSetupStepProps) {
  const ghCheck = useCliCheck("gh");
  const ghAuth = useGhAuth(ghCheck.data?.installed === true);

  const installed = ghCheck.isLoading ? null : (ghCheck.data?.installed ?? false);
  const authenticated = ghAuth.data?.authenticated ?? false;
  const username = ghAuth.data?.username;

  function getDetail(): string {
    if (ghCheck.data?.webMode) return "CLI checks require the desktop app";
    if (!installed) return "GitHub CLI not found";
    if (ghAuth.isLoading) return "Checking authentication...";
    if (authenticated && username) return `Authenticated as ${username}`;
    if (authenticated) return "Authenticated";
    return "Not authenticated — run: gh auth login";
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-white">GitHub</h2>
        <p className="text-sm text-white/50">
          Connect GitHub to create branches and pull requests from your workspaces.
        </p>
      </div>

      <CliStatusRow
        name="GitHub CLI"
        description="Required for Git operations"
        installed={installed}
        detail={getDetail()}
        actionLabel={installed === false ? "Install" : undefined}
        actionUrl={installed === false ? "https://cli.github.com" : undefined}
        onRetry={() => {
          ghCheck.refetch();
          ghAuth.refetch();
        }}
      />

      {installed && !ghAuth.isLoading && !authenticated && (
        <div className="rounded-xl bg-white/5 p-4">
          <p className="mb-2 text-xs font-medium text-white/70">Run this in your terminal:</p>
          <code className="block rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-white/80">
            gh auth login
          </code>
        </div>
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
        {installed && authenticated && (
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
