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
} from "lucide-react";
import { match } from "ts-pattern";
import { track } from "@/platform/analytics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { BranchSelector } from "./BranchSelector";
import {
  RESOLVE_CONFLICTS,
  fixCIPrompt,
  ADDRESS_REVIEW,
  MERGE_PR,
} from "@/features/session/lib/sessionPrompts";
import { mergeLabel, type PRActionState } from "../lib/prState";

interface PRActionsProps {
  state: PRActionState;
  onCreatePR?: () => void;
  onSendAgentMessage?: (text: string) => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
  workspaceId?: string;
  repoId?: string;
}

export function PRActions({
  state,
  onCreatePR,
  onSendAgentMessage,
  onArchive,
  targetBranch,
  onTargetBranchChange,
  workspaceId,
  repoId,
}: PRActionsProps) {
  if (state.type === "checking" || state.type === "no_remote") return null;

  return (
    <div className="flex items-center gap-1.5">
      {/* PR number link -- shown for all states that have a PR */}
      <PRLink state={state} />

      {/* State-specific rendering: status text OR action button */}
      {match(state)
        .with({ type: "gh_unavailable" }, (s) => <PRWarning message={s.warning} tone="warning" />)
        .with({ type: "linked" }, (s) => <PRWarning message={s.warning} tone="destructive" />)
        .with({ type: "create_pr" }, ({ warning }) => (
          <>
            <CreatePRButton
              targetBranch={targetBranch}
              repoId={repoId}
              onBranchSelect={onTargetBranchChange}
              onCreatePR={onCreatePR}
            />
            {warning && <PRWarning message={warning} tone="destructive" />}
          </>
        ))
        .with({ type: "ci_pending" }, (s) => (
          <StatusText
            icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
            label={s.checksTotal > 0 ? `${s.checksDone}/${s.checksTotal} checks` : "Checks running"}
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
        .with({ type: "ci_failing" }, (s) => (
          <ActionButton
            icon={<CircleX className="h-2.5 w-2.5" />}
            label={s.checksTotal > 0 ? `Fix CI · ${s.checksDone}/${s.checksTotal}` : "Fix CI"}
            variant="destructive"
            onClick={() => onSendAgentMessage?.(fixCIPrompt(s.failingChecks))}
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
            label={mergeLabel(s.baseBranch)}
            variant="success"
            onClick={() => {
              if (workspaceId) {
                track("pr_merged", { workspace_id: workspaceId, pr_number: s.prNumber });
              }
              onSendAgentMessage?.(MERGE_PR);
            }}
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
  if (!("prNumber" in state)) return null;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <a
          href={state.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "control-interaction flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium",
            PR_LINK_COLORS[state.type] ?? "text-text-secondary hover:text-text-primary"
          )}
        >
          <GitPullRequestCreate className="h-3 w-3" />#{state.prNumber}
        </a>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">Open PR in browser</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// PRWarning -- the reason the pull request could not be checked
// ---------------------------------------------------------------------------

function PRWarning({ message, tone }: { message: string; tone: "warning" | "destructive" }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={message}
          className={cn(
            "control-interaction flex cursor-help items-center gap-1 rounded-lg px-2 py-1",
            tone === "warning" ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive"
          )}
        >
          <AlertTriangle className="h-3 w-3" />
          <span className="text-sm font-medium">PR</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{message}</p>
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
        "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium",
        STATUS_VARIANT_CLASSES[variant]
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
        "control-interaction flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium",
        VARIANT_CLASSES[variant],
        disabled ? "cursor-not-allowed opacity-50" : "hover:opacity-90 active:opacity-80"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CreatePRButton -- split button with branch selector
// ---------------------------------------------------------------------------

function CreatePRButton({
  targetBranch,
  repoId,
  onBranchSelect,
  onCreatePR,
}: {
  targetBranch: string;
  repoId?: string;
  onBranchSelect: (branch: string) => void;
  onCreatePR?: () => void;
}) {
  return (
    <div className="flex h-7 overflow-hidden rounded-lg">
      <button
        type="button"
        onClick={onCreatePR}
        disabled={!onCreatePR}
        className={cn(
          "control-interaction bg-primary focus-visible:ring-primary-foreground/80 flex items-center gap-1.5 rounded-l-lg px-2.5 text-sm font-medium focus-visible:ring-inset",
          !onCreatePR
            ? "text-primary-foreground cursor-not-allowed opacity-50"
            : "text-primary-foreground hover:opacity-90 active:opacity-80"
        )}
      >
        <GitPullRequestCreate className="h-2.5 w-2.5" />
        <span>Create PR</span>
      </button>

      <BranchSelector
        repoId={repoId || null}
        currentBranch={targetBranch}
        onBranchSelect={onBranchSelect}
      >
        <button
          type="button"
          className="control-interaction bg-accent-blue-surface border-primary text-primary flex items-center gap-1 rounded-r-lg border-l px-2 text-sm font-normal hover:opacity-90 focus-visible:ring-inset active:opacity-80"
        >
          <span>{targetBranch}</span>
          <ChevronDown className="h-2 w-2" />
        </button>
      </BranchSelector>
    </div>
  );
}
