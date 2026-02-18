import { useState, useEffect, useRef } from "react";
import {
  ExternalLink,
  ChevronDown,
  Eye,
  GitMerge,
  GitPullRequestCreate,
  PanelLeft,
  Archive,
  AlertTriangle,
  CircleCheck,
  CircleX,
  Loader2,
  MessageSquareWarning,
  FileWarning,
  RotateCw,
  ScrollText,
  Sparkles,
  Copy,
  Check,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { invoke } from "@/platform/tauri";
import { BranchSelector } from "./BranchSelector";
import { cn } from "@/shared/lib/utils";
import type { PRStatus, GhCliStatus, SetupStatus } from "@/shared/types";
import type { NormalizedTask } from "../api/workspace.service";
import { TaskStrip } from "./TaskStrip";
import { AppIcon, groupAppsByCategory } from "@/shared/lib/appIcons";
import {
  fixSetupErrorPrompt,
  GENERATE_HIVE_JSON,
  RESOLVE_CONFLICTS,
  FIX_CI,
  ADDRESS_REVIEW,
  MERGE_PR,
} from "@/features/session/lib/sessionPrompts";

interface WorkspaceHeaderProps {
  title?: string;
  repositoryName?: string;
  branch?: string;
  workspacePath?: string;
  workspaceId?: string;
  prStatus?: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  setupStatus?: SetupStatus;
  setupError?: string | null;
  onCreatePR?: () => void;
  onSendAgentMessage?: (text: string) => void;
  onReviewPR?: () => void;
  onArchive?: () => void;
  onRetrySetup?: () => void;
  onViewSetupLogs?: () => void;
  tasks?: NormalizedTask[];
  hasManifest?: boolean;
  onRunTask?: (taskName: string) => void;
  targetBranch?: string;
  onTargetBranchChange?: (branch: string) => void;
}

/**
 * Unified workspace header — single 36px bar above all workspace content.
 *
 * Left: [sidebar toggle] title + repo/branch + Open button
 * Right: PR actions (Review always + Create PR / Merge / Archive depending on state)
 */
export function WorkspaceHeader({
  title,
  repositoryName,
  branch,
  workspacePath,
  prStatus,
  ghStatus,
  setupStatus,
  setupError,
  onCreatePR,
  onSendAgentMessage,
  onReviewPR,
  onArchive,
  onRetrySetup,
  onViewSetupLogs,
  tasks,
  hasManifest,
  onRunTask,
  targetBranch: targetBranchProp = "main",
  onTargetBranchChange,
}: WorkspaceHeaderProps) {
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const sidebarCollapsed = sidebarState === "collapsed";

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

  // gh CLI error states — show warning instead of broken PR buttons
  const ghMissing = ghStatus !== undefined && ghStatus !== null && !ghStatus.isInstalled;
  const ghUnauthenticated =
    ghStatus !== undefined &&
    ghStatus !== null &&
    ghStatus.isInstalled &&
    !ghStatus.isAuthenticated;

  const handleBranchSelect = (name: string) => {
    setLocalTargetBranch(name);
    onTargetBranchChange?.(name);
  };

  // Build subtitle: "repo / branch"
  const subtitle = [repositoryName, branch].filter(Boolean).join(" / ");

  return (
    <div data-slot="workspace-header" className="bg-bg-elevated border-border-subtle flex h-9 flex-shrink-0 items-center justify-between border-b px-4">
      {/* Left section */}
      <div className="flex min-w-0 items-center gap-[5px]">
        {/* Sidebar toggle — visible when collapsed */}
        {sidebarCollapsed && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={toggleSidebar}
                className="text-text-muted hover:text-text-secondary hover:bg-bg-muted mr-1 -ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors duration-200"
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Open sidebar</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Title (primary) — shown only when available */}
        {title && (
          <span className="text-foreground mr-0.5 max-w-[240px] truncate text-xs font-medium">
            {title}
          </span>
        )}

        {/* Repo / branch (secondary) */}
        {subtitle && (
          <span
            className="text-text-subtle max-w-[280px] truncate text-xs font-medium"
            title={subtitle}
          >
            {subtitle}
          </span>
        )}

        {/* Open in editor button — always visible */}
        {workspacePath && <HeaderOpenButton workspacePath={workspacePath} />}

        {/* Setup status indicator — shown when running or failed */}
        {setupStatus === "running" && (
          <span className="text-text-muted flex items-center gap-1 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Installing...</span>
          </span>
        )}
        {setupStatus === "failed" && (
          <div className="flex items-center gap-1">
            <span className="text-accent-red-muted flex items-center gap-1 text-xs font-medium">
              <AlertTriangle className="h-3 w-3" />
              <span>Setup failed</span>
            </span>
            {onViewSetupLogs && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onViewSetupLogs}
                    className="text-text-muted hover:text-text-secondary rounded-md px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <ScrollText className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">View setup logs</p>
                </TooltipContent>
              </Tooltip>
            )}
            {onSendAgentMessage && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() =>
                      onSendAgentMessage(fixSetupErrorPrompt(setupError ?? null))
                    }
                    className="text-text-muted hover:text-text-secondary rounded-md px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <Sparkles className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Ask AI to fix</p>
                </TooltipContent>
              </Tooltip>
            )}
            {onRetrySetup && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onRetrySetup}
                    className="text-text-muted hover:text-text-secondary rounded-md px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <RotateCw className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Retry setup</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        {/* Task strip from hive.json manifest — expands on hover */}
        {onRunTask && (
          <TaskStrip
            tasks={tasks ?? []}
            hasManifest={hasManifest ?? false}
            disabled={setupStatus === "running"}
            onRunTask={onRunTask}
            onSetupEnvironment={
              onSendAgentMessage
                ? () => onSendAgentMessage(GENERATE_HIVE_JSON)
                : undefined
            }
          />
        )}
      </div>

      {/* Right section — PR actions */}
      <div className="flex items-center gap-1.5">
        {/* PR status indicators — small chips when PR exists */}
        {hasPR && !isMerged && (
          <PRStatusChips
            ciStatus={ciStatus}
            reviewStatus={reviewStatus}
            hasConflicts={hasConflicts}
            isDraft={isDraft}
          />
        )}

        {/* Review button — visible when PR exists */}
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

        {/* gh CLI error states — show warning instead of broken PR buttons */}
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
        ) : /* State: Merged → Archive button */
        isMerged && onArchive ? (
          <button
            type="button"
            onClick={onArchive}
            className="bg-primary text-primary-foreground flex h-[23px] items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors duration-200 hover:opacity-90"
          >
            <Archive className="h-2.5 w-2.5" />
            <span>Archive</span>
          </button>
        ) : /* State: Has PR + conflicts → Resolve Conflicts action */
        hasPR && !isMerged && hasConflicts ? (
          <SplitButton
            icon={<FileWarning className="h-2.5 w-2.5" />}
            label="Resolve Conflicts"
            onLeftClick={() => onSendAgentMessage?.(RESOLVE_CONFLICTS)}
            leftDisabled={!onSendAgentMessage}
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : /* State: Has PR + CI failing → Fix CI action */
        hasPR && !isMerged && ciStatus === "failing" ? (
          <SplitButton
            icon={<CircleX className="h-2.5 w-2.5" />}
            label="Fix CI"
            onLeftClick={() => onSendAgentMessage?.(FIX_CI)}
            leftDisabled={!onSendAgentMessage}
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : /* State: Has PR + changes requested → Address Review action */
        hasPR && !isMerged && reviewStatus === "changes_requested" ? (
          <SplitButton
            icon={<MessageSquareWarning className="h-2.5 w-2.5" />}
            label="Address Review"
            onLeftClick={() => onSendAgentMessage?.(ADDRESS_REVIEW)}
            leftDisabled={!onSendAgentMessage}
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : /* State: Has PR + ready to merge → Merge action */
        hasPR && !isMerged && isReady ? (
          <SplitButton
            icon={<GitMerge className="h-2.5 w-2.5" />}
            label="Merge"
            onLeftClick={() => onSendAgentMessage?.(MERGE_PR)}
            leftDisabled={!onSendAgentMessage}
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : /* State: Has PR but blocked (generic — draft, needs review, CI pending) */
        hasPR && !isMerged ? (
          <SplitButton
            icon={<GitMerge className="h-2.5 w-2.5" />}
            label={isDraft ? "Draft" : ciStatus === "pending" ? "CI Running" : "Blocked"}
            onLeftClick={() => {}}
            leftDisabled
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : /* State: No PR → Create PR split button */
        !hasPR && !isMerged ? (
          <SplitButton
            icon={<GitPullRequestCreate className="h-2.5 w-2.5" />}
            label="Create PR"
            onLeftClick={onCreatePR ?? (() => {})}
            leftDisabled={!onCreatePR}
            branchLabel={effectiveTarget}
            workspacePath={workspacePath ?? null}
            currentBranch={effectiveTarget}
            onBranchSelect={handleBranchSelect}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PRStatusChips — small inline indicators for CI, review, conflicts
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
  // Only show chips that provide useful info — don't clutter with "unknown"
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
// SplitButton — shared visual for Create PR and Merge split buttons
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
}: SplitButtonProps) {
  return (
    <div className="flex h-[23px] overflow-hidden rounded-md">
      {/* Left: action */}
      <button
        type="button"
        onClick={onLeftClick}
        disabled={leftDisabled}
        className={cn(
          "bg-primary flex items-center gap-1.5 rounded-l-md px-2.5 text-xs font-semibold",
          "transition-colors duration-200",
          leftDisabled
            ? "text-primary-foreground cursor-not-allowed opacity-50"
            : "text-primary-foreground hover:opacity-90"
        )}
      >
        {icon}
        <span>{label}</span>
      </button>

      {/* Right: branch selector */}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeaderOpenButton — open workspace in external editors with product icons
// ---------------------------------------------------------------------------

interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon?: string; // base64 PNG data URL from native macOS icon
}

function HeaderOpenButton({ workspacePath }: { workspacePath: string }) {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  useEffect(() => {
    invoke<InstalledApp[]>("get_installed_apps")
      .then(setApps)
      .catch(() => {});
  }, []);

  function handleOpenInApp(appId: string) {
    setOpen(false);
    invoke("open_in_app", { appId, workspacePath }).catch(() => {});
  }

  function handleCopyPath() {
    navigator.clipboard
      .writeText(workspacePath)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
    setOpen(false);
  }

  function handleOpen() {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    isHoveringRef.current = true;
    setOpen(true);
  }

  function handleClose() {
    isHoveringRef.current = false;
    closeTimeoutRef.current = setTimeout(() => {
      if (!isHoveringRef.current) setOpen(false);
    }, 50);
  }

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const trigger = (
    <button
      type="button"
      className="text-text-subtle border-border-strong hover:bg-bg-muted flex items-center gap-1 rounded-[5px] border px-2 py-1 transition-colors duration-200"
      onPointerEnter={apps.length > 0 ? handleOpen : undefined}
      onPointerLeave={apps.length > 0 ? handleClose : undefined}
    >
      <ExternalLink className="h-[11px] w-[11px]" />
      <span className="text-2xs font-medium">Open</span>
      <ChevronDown className="text-text-muted h-2 w-2" />
    </button>
  );

  if (apps.length === 0) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Open in editor (desktop only)</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Group apps by category: editors → terminals → system
  const groups = groupAppsByCategory(apps);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[140px] shadow-sm"
        onPointerEnter={handleOpen}
        onPointerLeave={handleClose}
      >
        {groups.map((group, groupIdx) => (
          <div key={group.category}>
            {groupIdx > 0 && <DropdownMenuSeparator />}
            {group.apps.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onClick={() => handleOpenInApp(app.id)}
                className="cursor-pointer gap-2 py-1 text-xs"
              >
                {app.icon ? (
                  <img
                    src={app.icon}
                    alt=""
                    className="h-5 w-5 flex-shrink-0 rounded-[3px]"
                    draggable={false}
                  />
                ) : (
                  <AppIcon appId={app.id} className="h-5 w-5 flex-shrink-0" />
                )}
                {app.name}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleCopyPath}
          className="text-text-muted cursor-pointer gap-2 py-1 text-xs"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Copy className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {copied ? "Copied!" : "Copy path"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
