/**
 * PR Actions -- right-side actions for the content panel header.
 *
 * Architecture: PRStatus (bag of optionals) -> derivePRActionState (pure function)
 * -> PRActionState (discriminated union) -> exhaustive match -> JSX.
 *
 * Each PR state maps to exactly one visual representation:
 *   - "#N" link + contextual action button, OR
 *   - "#N" link + status text (non-actionable), OR
 *   - Create PR split button (pre-PR)
 *
 * No redundant chips. The button IS the status indicator.
 */

import { useState, useEffect } from "react";
import {
  GitMerge,
  GitPullRequestCreate,
  GitPullRequestClosed,
  ChevronDown,
  Archive,
  AlertTriangle,
  CircleX,
  Loader2,
  MessageSquareWarning,
  FileWarning,
  WifiOff,
} from "lucide-react";
import { match } from "ts-pattern";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { BranchSelector } from "./BranchSelector";
import {
  RESOLVE_CONFLICTS,
  FIX_CI,
  ADDRESS_REVIEW,
  MERGE_PR,
} from "@/features/session/lib/sessionPrompts";
import { derivePRActionState, type PRActionState } from "../lib/prState";
import type { PRStatus, GhCliStatus } from "@/shared/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PRActionsProps {
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  onCreatePR?: () => void;
  onSendAgentMessage?: (text: string) => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
  workspacePath: string | null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PRActions({
  prStatus,
  ghStatus,
  onCreatePR,
  onSendAgentMessage,
  onArchive,
  targetBranch: targetBranchProp = "main",
  onTargetBranchChange,
  workspacePath,
}: PRActionsProps) {
  const [localTargetBranch, setLocalTargetBranch] = useState(targetBranchProp);
  useEffect(() => {
    setLocalTargetBranch(targetBranchProp);
  }, [targetBranchProp]);

  const handleBranchSelect = (name: string) => {
    setLocalTargetBranch(name);
    onTargetBranchChange(name);
  };

  const state = derivePRActionState(prStatus, ghStatus, localTargetBranch);

  return (
    <div className="flex items-center gap-1.5">
      {/* PR number link -- shown for all states that have a PR */}
      <PRLink state={state} />

      {/* State-specific rendering: status text OR action button */}
      {match(state)
        .with({ type: "gh_unavailable" }, (s) => (
          <GhWarning reason={s.reason} />
        ))
        .with({ type: "error" }, (s) => (
          <ErrorWarning reason={s.reason} />
        ))
        .with({ type: "no_pr" }, () => (
          <CreatePRButton
            targetBranch={localTargetBranch}
            workspacePath={workspacePath}
            onBranchSelect={handleBranchSelect}
            onCreatePR={onCreatePR}
          />
        ))
        .with({ type: "ci_pending" }, () => (
          <StatusText
            icon={<Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />}
            label="Checks running"
            variant="pending"
          />
        ))
        .with({ type: "awaiting_review" }, () => (
          <StatusText label="Awaiting review" variant="review" />
        ))
        .with({ type: "closed" }, () => (
          <StatusText
            icon={<GitPullRequestClosed className="h-3 w-3" />}
            label="Closed"
            variant="closed"
          />
        ))
        .with({ type: "ci_failing" }, () => (
          <ActionButton
            icon={<CircleX className="h-2.5 w-2.5" />}
            label="Fix CI"
            variant="destructive"
            onClick={() => onSendAgentMessage?.(FIX_CI)}
            disabled={!onSendAgentMessage}
          />
        ))
        .with({ type: "conflicts" }, () => (
          <ActionButton
            icon={<FileWarning className="h-2.5 w-2.5" />}
            label="Resolve Conflicts"
            variant="destructive"
            onClick={() => onSendAgentMessage?.(RESOLVE_CONFLICTS)}
            disabled={!onSendAgentMessage}
          />
        ))
        .with({ type: "changes_requested" }, () => (
          <ActionButton
            icon={<MessageSquareWarning className="h-2.5 w-2.5" />}
            label="Address Review"
            variant="warning"
            onClick={() => onSendAgentMessage?.(ADDRESS_REVIEW)}
            disabled={!onSendAgentMessage}
          />
        ))
        .with({ type: "ready_to_merge" }, (s) => (
          <ActionButton
            icon={<GitMerge className="h-2.5 w-2.5" />}
            label={`Merge into ${s.targetBranch}`}
            variant="success"
            onClick={() => onSendAgentMessage?.(MERGE_PR)}
            disabled={!onSendAgentMessage}
          />
        ))
        .with({ type: "merged" }, () =>
          onArchive ? (
            <ActionButton
              icon={<Archive className="h-2.5 w-2.5" />}
              label="Archive"
              variant="primary"
              onClick={onArchive}
            />
          ) : null
        )
        .exhaustive()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PRLink -- "#N" clickable link to open PR in browser
// ---------------------------------------------------------------------------

function PRLink({ state }: { state: PRActionState }) {
  if (state.type === "gh_unavailable" || state.type === "no_pr" || state.type === "error") return null;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <a
          href={state.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold transition-colors duration-200 ease",
            PR_LINK_COLORS[state.type] ?? "text-text-secondary hover:text-text-primary",
          )}
        >
          <GitPullRequestCreate className="h-3 w-3" />
          #{state.prNumber}
        </a>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">Open PR in browser</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// GhWarning -- tooltip for missing/unauthenticated gh CLI
// ---------------------------------------------------------------------------

function GhWarning({ reason }: { reason: "not_installed" | "not_authenticated" }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="PR actions unavailable"
          className="flex items-center gap-1 rounded-md bg-warning/10 px-2 py-1 text-warning"
        >
          <AlertTriangle className="h-3 w-3" />
          <span className="text-sm font-medium">PR</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {reason === "not_installed"
            ? "GitHub CLI not installed \u2014 install gh to manage PRs"
            : "Not authenticated \u2014 run gh auth login"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// ErrorWarning -- tooltip for GitHub connectivity errors
// ---------------------------------------------------------------------------

function ErrorWarning({ reason }: { reason: "timeout" | "network" }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="GitHub unreachable"
          className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-destructive"
        >
          <WifiOff className="h-3 w-3" />
          <span className="text-sm font-medium">PR</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {reason === "timeout"
            ? "GitHub request timed out \u2014 will retry automatically"
            : "Could not reach GitHub \u2014 will retry automatically"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// StatusText -- non-actionable status (CI pending, awaiting review, closed)
// ---------------------------------------------------------------------------

const STATUS_VARIANT_CLASSES = {
  pending: "bg-warning/10 text-warning",
  review: "bg-primary/10 text-primary",
  closed: "bg-muted text-muted-foreground",
} as const;

function StatusText({
  icon,
  label,
  variant,
}: {
  icon?: React.ReactNode;
  label: string;
  variant: keyof typeof STATUS_VARIANT_CLASSES;
}) {
  return (
    <span
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium",
        STATUS_VARIANT_CLASSES[variant],
      )}
    >
      {icon}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ActionButton -- colored action button for fixable / actionable states
// ---------------------------------------------------------------------------

const VARIANT_CLASSES = {
  primary: "bg-primary text-primary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  warning: "bg-warning text-warning-foreground",
  success: "bg-success text-success-foreground",
} as const;

/** Maps PR state → link color so #N reads as part of the status unit. */
const PR_LINK_COLORS: Record<string, string> = {
  ci_pending: "text-warning/80 hover:text-warning",
  awaiting_review: "text-primary/80 hover:text-primary",
  ci_failing: "text-destructive/80 hover:text-destructive",
  conflicts: "text-destructive/80 hover:text-destructive",
  changes_requested: "text-warning/80 hover:text-warning",
  ready_to_merge: "text-success/80 hover:text-success",
  merged: "text-text-secondary hover:text-text-primary",
  closed: "text-muted-foreground/80 hover:text-muted-foreground",
};

function ActionButton({
  icon,
  label,
  variant,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  variant: keyof typeof VARIANT_CLASSES;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-semibold transition-colors duration-200",
        VARIANT_CLASSES[variant],
        disabled ? "cursor-not-allowed opacity-50" : "hover:opacity-90",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CreatePRButton -- split button with branch selector (only for no-PR state)
// ---------------------------------------------------------------------------

function CreatePRButton({
  targetBranch,
  workspacePath,
  onBranchSelect,
  onCreatePR,
}: {
  targetBranch: string;
  workspacePath: string | null;
  onBranchSelect: (branch: string) => void;
  onCreatePR?: () => void;
}) {
  return (
    <div className="flex h-7 overflow-hidden rounded-md">
      <button
        type="button"
        onClick={onCreatePR}
        disabled={!onCreatePR}
        className={cn(
          "bg-primary flex items-center gap-1.5 rounded-l-md px-2.5 text-sm font-semibold transition-colors duration-200",
          !onCreatePR
            ? "text-primary-foreground cursor-not-allowed opacity-50"
            : "text-primary-foreground hover:opacity-90",
        )}
      >
        <GitPullRequestCreate className="h-2.5 w-2.5" />
        <span>Create PR</span>
      </button>

      <BranchSelector
        workspacePath={workspacePath}
        currentBranch={targetBranch}
        onBranchSelect={onBranchSelect}
      >
        <button
          type="button"
          className="bg-accent-blue-surface border-primary text-primary flex items-center gap-1 rounded-r-md border-l px-2 text-sm font-medium transition-colors duration-200 hover:opacity-90"
        >
          <span>{targetBranch}</span>
          <ChevronDown className="h-2 w-2" />
        </button>
      </BranchSelector>
    </div>
  );
}
