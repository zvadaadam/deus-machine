import { useCliCheck } from "../../api";
import { CliStatusRow } from "../components/CliStatusRow";

interface AIToolsCheckStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function AIToolsCheckStep({ onNext, onBack }: AIToolsCheckStepProps) {
  const claudeCheck = useCliCheck("claude");
  const codexCheck = useCliCheck("codex");

  const claudeInstalled = claudeCheck.isLoading ? null : (claudeCheck.data?.installed ?? false);
  const codexInstalled = codexCheck.isLoading ? null : (codexCheck.data?.installed ?? false);

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-white">AI Coding Tools</h2>
        <p className="text-sm text-white/50">
          OpenDevs orchestrates these AI agents to write code in your projects.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <CliStatusRow
          name="Claude Code"
          description="Anthropic's coding agent"
          installed={claudeInstalled}
          detail={
            claudeCheck.data?.webMode
              ? "CLI checks require the desktop app"
              : claudeInstalled
                ? `Found at ${claudeCheck.data?.path}`
                : "Not installed"
          }
          actionLabel={claudeInstalled === false ? "Install" : undefined}
          actionUrl={
            claudeInstalled === false ? "https://docs.anthropic.com/en/docs/claude-code" : undefined
          }
          onRetry={() => claudeCheck.refetch()}
        />

        <CliStatusRow
          name="Codex"
          description="OpenAI's coding agent"
          installed={codexInstalled}
          detail={
            codexCheck.data?.webMode
              ? "CLI checks require the desktop app"
              : codexInstalled
                ? `Found at ${codexCheck.data?.path}`
                : "Not installed"
          }
          actionLabel={codexInstalled === false ? "Install" : undefined}
          actionUrl={codexInstalled === false ? "https://github.com/openai/codex" : undefined}
          onRetry={() => codexCheck.refetch()}
        />
      </div>

      <p className="text-xs text-white/30">
        You need at least one AI tool installed. You can add more later.
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
