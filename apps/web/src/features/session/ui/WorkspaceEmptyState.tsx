import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "@/features/sidebar/lib/utils";
import { DeusEmptyState } from "./DeusEmptyState";
import type { WorkspaceKind } from "@shared/enums";

interface WorkspaceEmptyStateProps {
  repoName?: string | null;
  parentBranch?: string | null;
  /** True when this workspace has never had any messages — show full onboarding */
  isFirstSession?: boolean;
  /** Cloud workspaces live in a sandbox, not a local safe copy — different subtitle. */
  kind?: WorkspaceKind;
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
/** The three things a workspace is for. */
function WorkspaceSteps() {
  return (
    <div className="flex items-baseline gap-6">
      {STEPS.map((step) => (
        <div key={step.num} className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground/30 font-mono text-xs font-medium">
            {String(step.num).padStart(2, "0")}
          </span>
          <span className="text-muted-foreground/50 text-sm">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function subtitle(
  repoName?: string | null,
  parentBranch?: string | null,
  kind?: WorkspaceKind
): string {
  const project = repoName ?? "your project";
  if (kind === "cloud") {
    return parentBranch
      ? `A cloud computer running ${project}, cloned from ${parentBranch}.`
      : `A cloud computer running ${project}.`;
  }
  if (parentBranch) {
    return `A safe copy of ${project}, branched from ${parentBranch}.`;
  }
  return `A safe copy of ${project}.`;
}

export function WorkspaceEmptyState({
  repoName,
  parentBranch,
  isFirstSession = false,
  kind,
  className,
}: WorkspaceEmptyStateProps) {
  // New tab in active workspace — minimal prompt
  if (!isFirstSession) {
    return (
      <div
        className={cn(
          "animate-fade-in-up flex h-full flex-col items-center justify-center",
          className
        )}
      >
        <p className="text-muted-foreground/50 text-sm">What would you like to work on?</p>
      </div>
    );
  }

  // Deus repo: the user is working on the IDE itself — show a special state
  const cleanRepoName = repoName ? getCleanRepoName(repoName) : repoName;
  if (cleanRepoName === "deus") {
    return <DeusEmptyState parentBranch={parentBranch} className={className} />;
  }

  // Fresh workspace — clean, confident, centered
  return (
    <div
      className={cn(
        "animate-fade-in-up flex h-full flex-col items-center justify-center",
        className
      )}
    >
      <div className="flex flex-col items-center gap-5">
        <div className="text-center">
          <h2 className="text-muted-foreground/60 text-xs font-semibold tracking-wide uppercase">
            Workspace ready
          </h2>
          <p className="text-muted-foreground/45 mt-1.5 text-sm">
            {subtitle(repoName, parentBranch, kind)}
          </p>
        </div>

        <WorkspaceSteps />
      </div>
    </div>
  );
}
