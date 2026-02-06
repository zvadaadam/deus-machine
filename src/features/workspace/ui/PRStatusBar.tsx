import { GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { PRStatus } from "@/shared/types";

interface PRStatusBarProps {
  prStatus?: PRStatus | null;
  onCreatePR?: () => void;
  onReviewPR?: () => void;
  onMergePR?: () => void;
  className?: string;
  /** Compact mode — hides PR title to fit narrow panel */
  compact?: boolean;
}

export function PRStatusBar({
  prStatus,
  onCreatePR,
  onReviewPR,
  onMergePR,
  className,
  compact,
}: PRStatusBarProps) {
  const hasPR = Boolean(prStatus?.has_pr && prStatus?.pr_number);
  const prLabel = prStatus?.pr_number ? `PR #${prStatus.pr_number}` : "No PR";
  const mergeStatus = prStatus?.merge_status;
  const isMerged = mergeStatus === "merged";
  const isBlocked = mergeStatus === "blocked";
  const mergeDisabled = !prStatus?.pr_url || isMerged || isBlocked;
  const showMergeButton = Boolean(onMergePR);
  const reviewLabel = showMergeButton ? "Review" : "View PR";

  return (
    <div
      className={cn(
        "border-border/40 bg-background/40 flex h-11 items-center justify-between gap-3 border-b px-3",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="border-border/40 bg-muted/30 text-muted-foreground flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium">
          <GitPullRequest className="text-primary h-3.5 w-3.5" />
          <span className="truncate">{prLabel}</span>
        </div>
        {!compact && hasPR && prStatus?.pr_title && (
          <span className="text-muted-foreground/70 max-w-[200px] truncate text-xs">
            {prStatus.pr_title}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {!hasPR ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={onCreatePR}
            disabled={!onCreatePR}
          >
            Create PR
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={onReviewPR}
              disabled={!onReviewPR}
            >
              {reviewLabel}
            </Button>
            {showMergeButton && (
              <Button
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  !mergeDisabled && "bg-success text-success-foreground hover:bg-success/90"
                )}
                onClick={onMergePR}
                disabled={mergeDisabled}
              >
                {isMerged ? "Merged" : isBlocked ? "Blocked" : "Merge"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
