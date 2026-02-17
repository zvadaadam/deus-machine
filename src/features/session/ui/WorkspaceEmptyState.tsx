import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/shared/lib/utils";

interface WorkspaceEmptyStateProps {
  branch?: string | null;
  parentBranch?: string | null;
  /** True when this workspace has never had any messages — show full onboarding */
  isFirstSession?: boolean;
  className?: string;
}

const STEPS = [
  { num: 1, label: "Build with AI" },
  { num: 2, label: "Review the code" },
  { num: 3, label: "Merge with PR" },
] as const;

export function WorkspaceEmptyState({
  branch,
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

  // Fresh workspace — full onboarding
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-4 animate-fade-in-up",
        className
      )}
    >
      {/* Heading */}
      <div className="space-y-1 text-center">
        <h2 className="text-muted-foreground/70 text-sm font-medium">
          Your workspace is ready
        </h2>
        <p className="text-muted-foreground/40 text-xs">
          A safe copy of your code — merge when you're happy.
        </p>
      </div>

      {/* Branch context badge */}
      {branch && (
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="gap-1 text-xs font-normal">
            <GitBranch className="h-3 w-3" aria-hidden="true" />
            {branch}
          </Badge>
          {parentBranch && (
            <span className="text-muted-foreground/40 text-xs">
              from {parentBranch}
            </span>
          )}
        </div>
      )}

      {/* Workflow — numbered steps */}
      <div className="flex items-center gap-4">
        {STEPS.map((step, i) => (
          <div key={step.num} className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground/30 tabular-nums">
                {step.num}.
              </span>
              <span className="text-xs text-muted-foreground/50 whitespace-nowrap">
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span className="text-muted-foreground/20 text-xs">—</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
