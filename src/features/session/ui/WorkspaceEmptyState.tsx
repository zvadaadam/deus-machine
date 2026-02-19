import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { match } from "ts-pattern";

interface WorkspaceEmptyStateProps {
  repoName?: string | null;
  parentBranch?: string | null;
  /** True when this workspace has never had any messages — show full onboarding */
  isFirstSession?: boolean;
  /** Workspace is still being set up — show spinner + step text instead of "ready" */
  initializing?: boolean;
  /** Current init pipeline step (worktree, dependencies, hooks, session) */
  initStep?: string | null;
  className?: string;
}

const STEPS = [
  { num: 1, label: "Build with AI" },
  { num: 2, label: "Review the diff" },
  { num: 3, label: "Open a pull request" },
] as const;

/**
 * Builds an educational subtitle that teaches git concepts through plain language:
 * - "branched from" introduces the concept of branching
 * - the parent branch name appears naturally without explanation
 */
function subtitle(repoName?: string | null, parentBranch?: string | null): string {
  const project = repoName ?? "your project";
  if (parentBranch) {
    return `A safe copy of ${project}, branched from ${parentBranch}.`;
  }
  return `A safe copy of ${project}.`;
}

export function WorkspaceEmptyState({
  repoName,
  parentBranch,
  isFirstSession = false,
  initializing = false,
  initStep,
  className,
}: WorkspaceEmptyStateProps) {
  // New tab in active workspace — minimal prompt
  if (!isFirstSession) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center animate-fade-in-up",
          className
        )}
      >
        <p className="text-sm text-muted-foreground/50">
          What would you like to work on?
        </p>
      </div>
    );
  }

  // Fresh workspace — clean, confident, centered
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center animate-fade-in-up",
        className
      )}
    >
      <div className="flex flex-col items-center gap-5">
        <div className="text-center">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/60 flex items-center justify-center gap-2">
            {initializing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {initializing
              ? match(initStep)
                  .with("worktree", () => "Creating worktree...")
                  .with("dependencies", () => "Installing dependencies...")
                  .with("hooks", () => "Setting up environment...")
                  .with("session", () => "Finalizing...")
                  .otherwise(() => "Setting up workspace...")
              : "Workspace ready"}
          </h2>
          {!initializing && (
            <p className="mt-1.5 text-sm text-muted-foreground/45">
              {subtitle(repoName, parentBranch)}
            </p>
          )}
        </div>

        <div className="flex items-baseline gap-6">
          {STEPS.map((step) => (
            <div key={step.num} className="flex items-baseline gap-1.5">
              <span className="font-mono text-xs font-medium text-muted-foreground/30">
                {String(step.num).padStart(2, "0")}
              </span>
              <span className="text-sm text-muted-foreground/50">{step.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
