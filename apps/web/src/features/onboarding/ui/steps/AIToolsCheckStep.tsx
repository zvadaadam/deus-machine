import { match } from "ts-pattern";
import { CliStatusRow } from "../components/CliStatusRow";
import { useAgentAuth, useAgentAuthEvents } from "@/features/settings/api/settings.queries";
import {
  canSignIn,
  installLocalAgents,
  readLocalAgent,
  signInLocalAgent,
  type LocalAgentState,
} from "@/features/settings/lib/local-agent-login";
import type { LocalHarness } from "@shared/agent-auth";

interface AIToolsCheckStepProps {
  onNext: () => void;
  onBack: () => void;
}

/** What the row says under the agent's name. */
function detailOf(state: LocalAgentState): string {
  return match(state)
    .with({ status: "checking" }, () => "Checking…")
    .with({ status: "failed" }, () => "Couldn’t check account")
    .with(
      { status: "installing" },
      ({ percent }) => `Installing${percent !== undefined ? ` · ${percent}%` : "…"}`
    )
    .with({ status: "not-installed" }, ({ error }) => error ?? "Not installed yet")
    .with({ status: "signed-out" }, ({ login }) =>
      login ? "Waiting for sign-in…" : "Sign in on this computer"
    )
    .with({ status: "signed-in" }, ({ account }) => account)
    .exhaustive();
}

export function AIToolsCheckStep({ onNext, onBack }: AIToolsCheckStepProps) {
  const auth = useAgentAuth();
  useAgentAuthEvents();

  /** Each agent as the engine has it: its CLI (installed by the engine), then its login. */
  function row(harness: LocalHarness) {
    const state = readLocalAgent(auth, harness);
    const offerSignIn = state.status === "signed-out" && !state.login && canSignIn(state.auth);
    const action = offerSignIn
      ? { label: "Sign in", run: () => void signInLocalAgent(harness, state.auth) }
      : state.status === "not-installed"
        ? { label: state.error ? "Try again" : "Install", run: () => void installLocalAgents() }
        : undefined;
    return {
      installed:
        state.status === "checking" || state.status === "installing"
          ? null
          : state.status !== "not-installed",
      detail: detailOf(state),
      actionLabel: action?.label,
      onAction: action?.run,
      onRetry: () => void auth.refetch(),
      showRetry: state.status === "failed" || state.status === "signed-out",
      retryLabel: "Check again",
      retryWhenUnavailable: false,
    };
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
          {...row("claude-code")}
        />

        <CliStatusRow
          name="Codex"
          description="OpenAI's coding agent"
          {...row("codex-app-server")}
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
