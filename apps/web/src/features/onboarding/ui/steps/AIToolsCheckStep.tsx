import { match } from "ts-pattern";
import { useCliCheck } from "../../api";
import { CliStatusRow } from "../components/CliStatusRow";
import { useAgentAuth } from "@/features/settings/api/settings.queries";
import { readLocalProviderAuth } from "@/features/settings/lib/local-provider-auth";
import { openProviderLogin } from "@/features/settings/lib/open-provider-login";

interface AIToolsCheckStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function AIToolsCheckStep({ onNext, onBack }: AIToolsCheckStepProps) {
  const claudeCheck = useCliCheck("claude");
  const codexCheck = useCliCheck("codex");
  const auth = useAgentAuth();
  const claudeAuth = readLocalProviderAuth(auth, "claude");

  const claudeInstalled = claudeCheck.isLoading ? null : (claudeCheck.data?.installed ?? false);
  const codexInstalled = codexCheck.isLoading ? null : (codexCheck.data?.installed ?? false);

  function claudeDetail(): string {
    if (claudeCheck.data?.webMode) return "CLI checks require the desktop app";
    if (claudeInstalled === null) return "Checking availability…";
    if (!claudeInstalled) return "Unavailable · Restart Deus and check again";
    return match(claudeAuth)
      .with({ status: "checking" }, () => "Checking account…")
      .with({ status: "failed" }, () => "Couldn’t check account")
      .with({ status: "signed-out" }, () => "Sign in on this computer")
      .with(
        { status: "signed-in" },
        ({ accountInfo }) => accountInfo.email ?? "Signed in on this computer"
      )
      .exhaustive();
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-onboarding-foreground text-2xl font-semibold">Connect your AI tools</h2>
        <p className="text-onboarding-foreground/50 text-sm">
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
          actionLabel={
            claudeInstalled && claudeAuth.status === "signed-out" ? "Sign in" : undefined
          }
          onAction={claudeInstalled ? () => void openProviderLogin("claude") : undefined}
          onRetry={() => {
            void claudeCheck.refetch();
            void auth.refetch();
          }}
          showRetry={
            claudeInstalled === true &&
            (claudeAuth.status === "failed" || claudeAuth.status === "signed-out")
          }
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

      <p className="text-onboarding-foreground/30 text-xs">
        Already signed in to Claude Code or Codex? Continue with that account. Otherwise, sign in to
        at least one tool above. You can finish this later in Settings.
      </p>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onBack}
          className="control-interaction text-onboarding-foreground/50 hover:text-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-normal"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          onClick={onNext}
          className="control-interaction bg-onboarding-foreground text-onboarding-contrast hover:bg-onboarding-foreground/90 active:bg-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-medium"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
