import { useCliCheck } from "../../api";
import { CliStatusRow } from "../components/CliStatusRow";
import { useAgentAuth } from "@/features/settings/api/settings.queries";
import { openProviderLogin } from "@/features/settings/lib/open-provider-login";

interface AIToolsCheckStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function AIToolsCheckStep({ onNext, onBack }: AIToolsCheckStepProps) {
  const claudeCheck = useCliCheck("claude");
  const codexCheck = useCliCheck("codex");
  const auth = useAgentAuth();
  const claudeAccount = auth.data?.claude?.error ? undefined : auth.data?.claude?.accountInfo;

  const claudeInstalled = claudeCheck.isLoading ? null : (claudeCheck.data?.installed ?? false);
  const codexInstalled = codexCheck.isLoading ? null : (codexCheck.data?.installed ?? false);

  function claudeDetail(): string {
    if (claudeCheck.data?.webMode) return "CLI checks require the desktop app";
    if (claudeInstalled === null) return "Checking availability…";
    if (!claudeInstalled) return "Unavailable · Restart Deus and check again";
    if (auth.isLoading) return "Checking account…";
    if (auth.isError || auth.data?.error || auth.data?.claude?.error)
      return "Couldn’t check account";
    return claudeAccount
      ? (claudeAccount.email ?? "Signed in on this computer")
      : "Sign in on this computer";
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-white">Connect your AI tools</h2>
        <p className="text-sm text-white/50">
          Local agents use the accounts signed in on this computer. You can manage cloud accounts
          separately in Settings → AI Providers.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <CliStatusRow
          name="Claude Code"
          description="Anthropic's coding agent"
          installed={claudeInstalled}
          detail={claudeDetail()}
          actionLabel={claudeInstalled && !auth.isLoading && !claudeAccount ? "Sign in" : undefined}
          onAction={claudeInstalled ? () => void openProviderLogin("claude") : undefined}
          onRetry={() => {
            void claudeCheck.refetch();
            void auth.refetch();
          }}
          showRetry={!auth.isLoading && !claudeAccount && claudeInstalled === true}
          retryLabel="Check again"
        />

        <CliStatusRow
          name="Codex"
          description="OpenAI's coding agent"
          installed={codexInstalled}
          detail={
            codexCheck.data?.webMode
              ? "CLI checks require the desktop app"
              : codexInstalled === null
                ? "Checking availability…"
                : codexInstalled
                  ? "Login managed by Codex"
                  : "Unavailable · Restart Deus and check again"
          }
          actionLabel={codexInstalled ? "Sign in" : undefined}
          onAction={codexInstalled ? () => void openProviderLogin("codex") : undefined}
          onRetry={() => codexCheck.refetch()}
        />
      </div>

      <p className="text-xs text-white/30">
        Already signed in to Claude Code or Codex? Continue with that account. Otherwise, sign in to
        at least one tool above. You can finish this later in Settings.
      </p>

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
          className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
