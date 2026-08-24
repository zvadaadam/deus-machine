import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { match } from "ts-pattern";
import { getCleanRepoName } from "@/features/sidebar/lib/utils";
import { DeusEmptyState } from "./DeusEmptyState";
import type { WorkspaceKind } from "@shared/enums";

interface WorkspaceEmptyStateProps {
  repoName?: string | null;
  parentBranch?: string | null;
  /** True when this workspace has never had any messages — show full onboarding */
  isFirstSession?: boolean;
  /** Workspace is still being set up — show spinner + step text instead of "ready" */
  initializing?: boolean;
  /** Current init pipeline step (worktree, dependencies, hooks, session) */
  initStep?: string | null;
  /** Provisioning failed — the row is selectable so the failure is visible,
   *  and this panel must agree with the sidebar instead of saying "ready". */
  failed?: boolean;
  failureMessage?: string | null;
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
function subtitle(
  repoName?: string | null,
  parentBranch?: string | null,
  kind?: WorkspaceKind
): string {
  const project = repoName ?? "your project";
  if (kind === "cloud") {
    return parentBranch
      ? `A cloud sandbox running ${project}, cloned from ${parentBranch}.`
      : `A cloud sandbox running ${project}.`;
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
  initializing = false,
  initStep,
  failed = false,
  failureMessage,
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
          <h2 className="text-muted-foreground/60 flex items-center justify-center gap-2 text-xs font-semibold tracking-wide uppercase">
            {initializing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {failed
              ? "Workspace setup failed"
              : initializing
                ? match(initStep)
                    .with("worktree", () => "Creating worktree...")
                    .with("dependencies", () => "Installing dependencies...")
                    .with("hooks", () => "Setting up environment...")
                    .with("session", () => "Finalizing...")
                    .otherwise(() => "Setting up workspace...")
                : "Workspace ready"}
          </h2>
          {failed ? (
            <p className="text-accent-red-muted mt-1.5 text-sm">
              {failureMessage ?? "Provisioning did not complete. Archive this workspace and retry."}
            </p>
          ) : (
            !initializing && (
              <p className="text-muted-foreground/45 mt-1.5 text-sm">
                {subtitle(repoName, parentBranch, kind)}
              </p>
            )
          )}
        </div>

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
      </div>
    </div>
  );
}
