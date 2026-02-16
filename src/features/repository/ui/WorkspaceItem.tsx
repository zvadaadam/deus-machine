import { Circle, LoaderCircle, GitPullRequest } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { cn } from "@/shared/lib/utils";
import type { Workspace, DiffStats } from "@/shared/types";

interface WorkspaceItemProps {
  workspace: Workspace;
  diffStats?: DiffStats;
  isActive: boolean;
  onClick: () => void;
}

/**
 * WorkspaceItem — V2: Jony Ive
 *
 * "True simplicity is derived from so much more than
 *  just the absence of clutter."
 *
 * Layout:
 *   [StatusIcon 14×14] [Name — Inter 13/500]     [+713 -2]
 *                       [Location · Status]
 *
 * Selected: bg-elevated, rounded-md
 * Hover: bg-surface, rounded-md
 * Normal: transparent
 *
 * Status icons:
 *   working  → LoaderCircle (animated) in accent-blue
 *   review   → Circle in accent-gold
 *   default  → GitPullRequest in neutral-600
 */
export function WorkspaceItem({ workspace, diffStats, isActive, onClick }: WorkspaceItemProps) {
  const hasDiff = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);
  const timeAgo = formatTimeAgo(workspace.updated_at);
  const isWorking = workspace.session_status === "working";
  const isNeedsResponse = workspace.session_status === "needs_response";

  // Format branch name: show "owner/branch" or just "branch"
  const displayName = workspace.branch?.includes("/")
    ? workspace.branch
    : `${workspace.directory_name}/${workspace.branch}`;

  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-150",
          isActive ? "bg-bg-selection" : "hover:bg-bg-surface"
        )}
      >
        {/* Left: status + text */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Row 1: status icon + name */}
          <div className="flex items-center gap-1.5">
            {isWorking ? (
              <LoaderCircle className="text-text-muted h-3.5 w-3.5 shrink-0 animate-[subtle-spin_2s_linear_infinite]" />
            ) : isNeedsResponse ? (
              <Circle className="text-text-secondary h-2 w-2 shrink-0 fill-current" />
            ) : (
              <GitPullRequest className="text-text-muted h-3.5 w-3.5 shrink-0" />
            )}
            <span
              className={cn(
                "truncate text-[13px]",
                isActive
                  ? "text-text-primary font-medium"
                  : isWorking || isNeedsResponse
                    ? "text-text-primary font-normal"
                    : "text-text-tertiary font-normal"
              )}
            >
              {displayName}
            </span>
          </div>

          {/* Row 2: location · time/status */}
          <div className="flex items-center gap-1.5 pl-5">
            <span className="text-text-muted truncate text-xs">{workspace.directory_name}</span>
            <span className="text-text-muted text-xs">·</span>
            {isWorking ? (
              <span className="text-accent-blue text-xs">Working...</span>
            ) : isNeedsResponse ? (
              <span className="text-accent-gold text-xs">Needs review</span>
            ) : (
              <span className="text-text-muted text-xs">{timeAgo}</span>
            )}
          </div>
        </div>

        {/* Right: diff stats */}
        {hasDiff && (
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {diffStats.additions > 0 && (
              <NumberFlow
                value={diffStats.additions}
                prefix="+"
                className={cn(
                  "text-xs font-medium",
                  isActive ? "text-accent-green" : "text-accent-green-muted"
                )}
              />
            )}
            {diffStats.deletions > 0 && (
              <NumberFlow
                value={diffStats.deletions}
                prefix="-"
                className={cn(
                  "text-xs font-medium",
                  isActive ? "text-accent-red" : "text-accent-red-muted"
                )}
              />
            )}
          </div>
        )}
      </button>
    </li>
  );
}
