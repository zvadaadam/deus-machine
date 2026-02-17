import { cn } from "@/shared/lib/utils";

interface WorkspaceEmptyStateProps {
  repoName?: string | null;
  parentBranch?: string | null;
  /** True when this workspace has never had any messages — show full onboarding */
  isFirstSession?: boolean;
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
        <p className="text-muted-foreground/40 text-xs">
          What would you like to work on?
        </p>
      </div>
    );
  }

  // Fresh workspace — Dieter Rams inspired: functional, systematic, centered
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center animate-fade-in-up",
        className
      )}
    >
      <div className="flex flex-col items-center gap-3.5">
        <div className="text-center">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
            Workspace ready
          </h2>
          <p className="mt-1 text-muted-foreground/30 text-xs max-w-[280px]">
            {subtitle(repoName, parentBranch)}
          </p>
        </div>

        <div className="flex items-baseline gap-4">
          {STEPS.map((step) => (
            <div key={step.num} className="flex items-baseline gap-1.5">
              <span className="font-mono text-[10px] font-medium text-muted-foreground/20">
                {String(step.num).padStart(2, "0")}
              </span>
              <span className="text-xs text-muted-foreground/40">{step.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
