/**
 * PR Actions -- right-side actions for the content panel header.
 *
 * Renders PR status chips, Review button, and the Create PR / Merge
 * split button. Extracted from WorkspaceHeader so the actions live
 * in the right panel's tab header (per the new layout design).
 */

import { useState, useEffect } from "react";
import {
  Eye,
  GitMerge,
  GitPullRequestCreate,
  ChevronDown,
  Archive,
  AlertTriangle,
  CircleCheck,
  CircleX,
  Loader2,
  MessageSquareWarning,
  FileWarning,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { BranchSelector } from "./BranchSelector";
import {
  RESOLVE_CONFLICTS,
  FIX_CI,
  ADDRESS_REVIEW,
  MERGE_PR,
} from "@/features/session/lib/sessionPrompts";
import type { PRStatus, GhCliStatus } from "@/shared/types";

interface PRActionsProps {
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  onCreatePR?: () => void;
  onSendAgentMessage?: (text: string) => void;
  onReviewPR?: () => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
  workspacePath: string | null;
}

export function PRActions({
  prStatus,
  ghStatus,
  onCreatePR,
  onSendAgentMessage,
  onReviewPR,
  onArchive,
  targetBranch: targetBranchProp = "main",
  onTargetBranchChange,
  workspacePath,
}: PRActionsProps) {
  const [localTargetBranch, setLocalTargetBranch] = useState(targetBranchProp);
  useEffect(() => {
    setLocalTargetBranch(targetBranchProp);
  }, [targetBranchProp]);
  const effectiveTarget = localTargetBranch;

  const hasPR = Boolean(prStatus?.has_pr && prStatus?.pr_number);
  const isMerged = prStatus?.merge_status === "merged";
  const isReady = prStatus?.merge_status === "ready";
  const hasConflicts = prStatus?.has_conflicts === true;
  const ciStatus = prStatus?.ci_status;
  const reviewStatus = prStatus?.review_status;
  const isDraft = prStatus?.is_draft === true;

  const ghMissing = ghStatus !== undefined && ghStatus !== null && !ghStatus.isInstalled;
  const ghUnauthenticated =
    ghStatus !== undefined &&
    ghStatus !== null &&
    ghStatus.isInstalled &&
    !ghStatus.isAuthenticated;

  const handleBranchSelect = (name: string) => {
    setLocalTargetBranch(name);
    onTargetBranchChange(name);
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* PR status indicators */}
      {hasPR && !isMerged && (
        <PRStatusChips
          ciStatus={ciStatus}
          reviewStatus={reviewStatus}
          hasConflicts={hasConflicts}
          isDraft={isDraft}
        />
      )}

      {/* Review button */}
      {hasPR && onReviewPR && (
        <button
          type="button"
          onClick={onReviewPR}
          className="text-text-tertiary hover:text-text-secondary flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors duration-200"
        >
          <Eye className="h-3 w-3" />
          <span>Review</span>
        </button>
      )}

      {/* gh CLI error states */}
      {ghMissing || ghUnauthenticated ? (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <div className="text-text-muted flex items-center gap-1 px-2 py-1">
              <AlertTriangle className="text-warning h-3 w-3" />
              <span className="text-xs font-medium">PR</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {ghMissing
                ? "GitHub CLI not installed — install gh to manage PRs"
                : "Not authenticated — run gh auth login"}
            </p>
          </TooltipContent>
        </Tooltip>
      ) : isMerged && onArchive ? (
        <button
          type="button"
          onClick={onArchive}
          className="bg-primary text-primary-foreground flex h-[23px] items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors duration-200 hover:opacity-90"
        >
          <Archive className="h-2.5 w-2.5" />
          <span>Archive</span>
        </button>
      ) : hasPR && !isMerged && hasConflicts ? (
        <SplitButton
          icon={<FileWarning className="h-2.5 w-2.5" />}
          label="Resolve Conflicts"
          onLeftClick={() => onSendAgentMessage?.(RESOLVE_CONFLICTS)}
          leftDisabled={!onSendAgentMessage}
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
          branchEditable={false}
        />
      ) : hasPR && !isMerged && ciStatus === "failing" ? (
        <SplitButton
          icon={<CircleX className="h-2.5 w-2.5" />}
          label="Fix CI"
          onLeftClick={() => onSendAgentMessage?.(FIX_CI)}
          leftDisabled={!onSendAgentMessage}
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
          branchEditable={false}
        />
      ) : hasPR && !isMerged && reviewStatus === "changes_requested" ? (
        <SplitButton
          icon={<MessageSquareWarning className="h-2.5 w-2.5" />}
          label="Address Review"
          onLeftClick={() => onSendAgentMessage?.(ADDRESS_REVIEW)}
          leftDisabled={!onSendAgentMessage}
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
          branchEditable={false}
        />
      ) : hasPR && !isMerged && isReady ? (
        <SplitButton
          icon={<GitMerge className="h-2.5 w-2.5" />}
          label="Merge"
          onLeftClick={() => onSendAgentMessage?.(MERGE_PR)}
          leftDisabled={!onSendAgentMessage}
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
          branchEditable={false}
        />
      ) : hasPR && !isMerged ? (
        <SplitButton
          icon={<GitMerge className="h-2.5 w-2.5" />}
          label={isDraft ? "Draft" : ciStatus === "pending" ? "CI Running" : "Blocked"}
          onLeftClick={() => {}}
          leftDisabled
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
          branchEditable={false}
        />
      ) : !hasPR && !isMerged ? (
        <SplitButton
          icon={<GitPullRequestCreate className="h-2.5 w-2.5" />}
          label="Create PR"
          onLeftClick={onCreatePR ?? (() => {})}
          leftDisabled={!onCreatePR}
          branchLabel={effectiveTarget}
          workspacePath={workspacePath}
          currentBranch={effectiveTarget}
          onBranchSelect={handleBranchSelect}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PRStatusChips
// ---------------------------------------------------------------------------

function PRStatusChips({
  ciStatus,
  reviewStatus,
  hasConflicts,
  isDraft,
}: {
  ciStatus?: string;
  reviewStatus?: string;
  hasConflicts?: boolean;
  isDraft?: boolean;
}) {
  const chips: { icon: React.ReactNode; label: string; color: string }[] = [];

  if (isDraft) {
    chips.push({ icon: null, label: "Draft", color: "text-text-muted" });
  }
  if (hasConflicts) {
    chips.push({
      icon: <FileWarning className="h-2.5 w-2.5" />,
      label: "Conflicts",
      color: "text-destructive",
    });
  }
  if (ciStatus === "passing") {
    chips.push({
      icon: <CircleCheck className="h-2.5 w-2.5" />,
      label: "CI",
      color: "text-success",
    });
  } else if (ciStatus === "failing") {
    chips.push({
      icon: <CircleX className="h-2.5 w-2.5" />,
      label: "CI",
      color: "text-destructive",
    });
  } else if (ciStatus === "pending") {
    chips.push({
      icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
      label: "CI",
      color: "text-warning",
    });
  }
  if (reviewStatus === "approved") {
    chips.push({
      icon: <CircleCheck className="h-2.5 w-2.5" />,
      label: "Approved",
      color: "text-success",
    });
  } else if (reviewStatus === "changes_requested") {
    chips.push({
      icon: <MessageSquareWarning className="h-2.5 w-2.5" />,
      label: "Changes",
      color: "text-warning",
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={cn("flex items-center gap-0.5 text-2xs font-medium", chip.color)}
        >
          {chip.icon}
          {chip.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SplitButton
// ---------------------------------------------------------------------------

interface SplitButtonProps {
  icon: React.ReactNode;
  label: string;
  onLeftClick: () => void;
  leftDisabled?: boolean;
  branchLabel: string;
  workspacePath: string | null;
  currentBranch: string;
  onBranchSelect: (branch: string) => void;
  /** When false, branch is shown as static text (no dropdown). Use for post-PR states. */
  branchEditable?: boolean;
}

function SplitButton({
  icon,
  label,
  onLeftClick,
  leftDisabled,
  branchLabel,
  workspacePath,
  currentBranch,
  onBranchSelect,
  branchEditable = true,
}: SplitButtonProps) {
  return (
    <div className="flex h-[23px] overflow-hidden rounded-md">
      <button
        type="button"
        onClick={onLeftClick}
        disabled={leftDisabled}
        className={cn(
          "bg-primary flex items-center gap-1.5 px-2.5 text-xs font-semibold",
          "transition-colors duration-200",
          branchEditable ? "rounded-l-md" : "rounded-md",
          leftDisabled
            ? "text-primary-foreground cursor-not-allowed opacity-50"
            : "text-primary-foreground hover:opacity-90"
        )}
      >
        {icon}
        <span>{label}</span>
        {/* Show branch inline when not editable */}
        {!branchEditable && (
          <span className="text-primary-foreground/70 font-medium">into {branchLabel}</span>
        )}
      </button>

      {branchEditable && (
        <BranchSelector
          workspacePath={workspacePath}
          currentBranch={currentBranch}
          onBranchSelect={onBranchSelect}
        >
          <button
            type="button"
            className={cn(
              "bg-accent-blue-surface border-primary text-primary flex items-center gap-1 border-l px-2 text-xs font-medium",
              "rounded-r-md transition-colors duration-200 hover:opacity-90"
            )}
          >
            <span>{branchLabel}</span>
            <ChevronDown className="h-2 w-2" />
          </button>
        </BranchSelector>
      )}
    </div>
  );
}
