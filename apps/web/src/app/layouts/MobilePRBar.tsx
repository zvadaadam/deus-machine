/**
 * MobilePRBar -- compact PR status UI for mobile web layout.
 *
 * Two exports:
 *   MobilePRHeaderAction  -- "Create PR" pill for the header row (no-PR state only)
 *   MobilePRStatusBar     -- 32px bar below header (all states with an existing PR)
 *
 * Uses the same derivePRActionState function as the desktop PRActions component
 * to keep state logic unified. Only the presentation differs.
 */

import { useState } from "react";
import {
  GitPullRequestCreate,
  GitPullRequestClosed,
  GitMerge,
  CircleX,
  FileWarning,
  MessageSquareWarning,
  Archive,
  Loader2,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { match } from "ts-pattern";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/shared/lib/utils";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";
import { derivePRActionState } from "@/features/workspace/lib/prState";
import {
  RESOLVE_CONFLICTS,
  fixCIPrompt,
  ADDRESS_REVIEW,
  MERGE_PR,
} from "@/features/session/lib/sessionPrompts";
import { track } from "@/platform/analytics";
import type { PRStatus, GhCliStatus } from "@/shared/types";

// ---------------------------------------------------------------------------
// Shared props
// ---------------------------------------------------------------------------

interface MobilePRBarProps {
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  onCreatePR?: () => void;
  onSendAgentMessage?: (text: string) => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
  workspaceId?: string;
  repoId?: string;
}

// ---------------------------------------------------------------------------
// MobilePRHeaderAction -- compact "Create PR" pill for the header row
// ---------------------------------------------------------------------------

/**
 * Renders a small "Create PR" pill in the mobile header.
 * Only visible when no PR exists yet. Returns null otherwise.
 */
export function MobilePRHeaderAction({
  prStatus,
  ghStatus,
  onCreatePR,
  onArchive,
  targetBranch,
  onTargetBranchChange,
  repoId,
}: MobilePRBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const state = derivePRActionState(prStatus, ghStatus, targetBranch);

  if (state.type !== "no_pr") return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        disabled={!onCreatePR}
        className={cn(
          "bg-primary text-primary-foreground flex h-7 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-opacity duration-200",
          !onCreatePR ? "cursor-not-allowed opacity-50" : "hover:opacity-90"
        )}
      >
        <GitPullRequestCreate className="h-3 w-3" />
        <span>Create PR</span>
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-xl">
          <SheetHeader>
            <SheetTitle>Create Pull Request</SheetTitle>
            <SheetDescription>Select target branch and create a PR.</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 px-4 pb-4">
            {/* Target branch selector */}
            <div className="flex flex-col gap-2">
              <span className="text-text-muted text-xs font-medium">Target branch</span>
              <BranchSelector
                repoId={repoId ?? null}
                currentBranch={targetBranch}
                onBranchSelect={onTargetBranchChange}
              >
                <button
                  type="button"
                  className="border-border-subtle bg-bg-elevated flex h-10 w-full items-center justify-between rounded-lg border px-3 text-sm"
                >
                  <span className="text-foreground font-medium">{targetBranch}</span>
                  <ChevronDown className="text-text-muted h-3.5 w-3.5" />
                </button>
              </BranchSelector>
            </div>

            {/* Create PR action */}
            <button
              type="button"
              onClick={() => {
                onCreatePR?.();
                setSheetOpen(false);
              }}
              disabled={!onCreatePR}
              className={cn(
                "bg-primary text-primary-foreground flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-opacity duration-200",
                !onCreatePR ? "cursor-not-allowed opacity-50" : "hover:opacity-90"
              )}
            >
              <GitPullRequestCreate className="h-4 w-4" />
              Create PR
            </button>

            {/* Archive secondary action */}
            {onArchive && (
              <>
                <Separator />
                <button
                  type="button"
                  onClick={() => {
                    onArchive();
                    setSheetOpen(false);
                  }}
                  className="text-text-muted hover:text-text-secondary flex h-9 w-full items-center justify-center gap-2 text-sm transition-colors duration-200"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archive workspace
                </button>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// MobilePRStatusBar -- 32px bar for states with an existing PR
// ---------------------------------------------------------------------------

/**
 * Renders a compact status bar below the mobile header showing PR status.
 * Only visible when a PR exists. Returns null for no_pr, gh_unavailable, and error.
 */
export function MobilePRStatusBar({
  prStatus,
  ghStatus,
  onSendAgentMessage,
  onArchive,
  targetBranch,
  workspaceId,
}: MobilePRBarProps) {
  const state = derivePRActionState(prStatus, ghStatus, targetBranch);

  return match(state)
    .with({ type: "gh_unavailable" }, () => null)
    .with({ type: "error" }, () => null)
    .with({ type: "no_pr" }, () => null)
    .with({ type: "ci_pending" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-warning flex items-center gap-1 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} />
          {s.checksTotal > 0 ? `${s.checksDone}/${s.checksTotal} checks` : "Checks running"}
        </span>
      </StatusBar>
    ))
    .with({ type: "ci_failing" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-destructive flex items-center gap-1 text-xs">
          <CircleX className="h-3 w-3" />
          CI failing
        </span>
        <BarAction
          label="Fix CI"
          variant="destructive"
          onClick={() => onSendAgentMessage?.(fixCIPrompt(s.failingChecks))}
          disabled={!onSendAgentMessage}
        />
      </StatusBar>
    ))
    .with({ type: "conflicts" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-destructive flex items-center gap-1 text-xs">
          <FileWarning className="h-3 w-3" />
          Conflicts
        </span>
        <BarAction
          label="Resolve"
          variant="destructive"
          onClick={() => onSendAgentMessage?.(RESOLVE_CONFLICTS)}
          disabled={!onSendAgentMessage}
        />
      </StatusBar>
    ))
    .with({ type: "changes_requested" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-warning flex items-center gap-1 text-xs">
          <MessageSquareWarning className="h-3 w-3" />
          Changes requested
        </span>
        <BarAction
          label="Address"
          variant="warning"
          onClick={() => onSendAgentMessage?.(ADDRESS_REVIEW)}
          disabled={!onSendAgentMessage}
        />
      </StatusBar>
    ))
    .with({ type: "ready_to_merge" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-success flex items-center gap-1 text-xs">
          <GitMerge className="h-3 w-3" />
          Ready
        </span>
        <BarAction
          label="Merge"
          variant="success"
          onClick={() => {
            if (workspaceId) {
              track("pr_merged", { workspace_id: workspaceId, pr_number: s.prNumber });
            }
            onSendAgentMessage?.(MERGE_PR);
          }}
          disabled={!onSendAgentMessage}
        />
      </StatusBar>
    ))
    .with({ type: "awaiting_review" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-text-muted text-xs">Awaiting review</span>
      </StatusBar>
    ))
    .with({ type: "merged" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-text-muted flex items-center gap-1 text-xs">
          <GitMerge className="h-3 w-3" />
          Merged
        </span>
        {onArchive && <BarAction label="Archive" variant="primary" onClick={onArchive} />}
      </StatusBar>
    ))
    .with({ type: "closed" }, (s) => (
      <StatusBar prNumber={s.prNumber} prUrl={s.prUrl}>
        <span className="text-text-muted flex items-center gap-1 text-xs">
          <GitPullRequestClosed className="h-3 w-3" />
          Closed
        </span>
      </StatusBar>
    ))
    .exhaustive();
}

// ---------------------------------------------------------------------------
// StatusBar -- shared layout wrapper for the 32px bar
// ---------------------------------------------------------------------------

function StatusBar({
  prNumber,
  prUrl,
  children,
}: {
  prNumber: number;
  prUrl: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="mobile-pr-bar"
      className="border-border-subtle flex h-8 flex-shrink-0 items-center gap-2 border-b px-4"
    >
      {/* PR link */}
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-muted hover:text-text-secondary flex flex-shrink-0 items-center gap-1 text-xs font-semibold transition-colors duration-200"
      >
        <GitPullRequestCreate className="h-3 w-3" />#{prNumber}
        <ExternalLink className="h-2.5 w-2.5" />
      </a>

      {/* Separator dot */}
      <span className="bg-border-subtle h-0.5 w-0.5 flex-shrink-0 rounded-full" />

      {/* Status + optional action -- pushed apart */}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BarAction -- compact action button for the status bar
// ---------------------------------------------------------------------------

const BAR_VARIANT_CLASSES = {
  primary: "bg-primary text-primary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  warning: "bg-warning text-warning-foreground",
  success: "bg-success text-success-foreground",
} as const;

function BarAction({
  label,
  variant,
  onClick,
  disabled,
}: {
  label: string;
  variant: keyof typeof BAR_VARIANT_CLASSES;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-5.5 flex-shrink-0 items-center rounded-md px-2 text-xs font-semibold transition-opacity duration-200",
        BAR_VARIANT_CLASSES[variant],
        disabled ? "cursor-not-allowed opacity-50" : "hover:opacity-90"
      )}
    >
      {label}
    </button>
  );
}
