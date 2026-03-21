import React from "react";
import { match } from "ts-pattern";
import { Archive, Loader2 } from "lucide-react";
import NumberFlow from "@number-flow/react";

import { cn } from "@/shared/lib/utils";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { PixelGrid } from "@/features/session/ui/PixelGrid";
import { getDisplayStatus, STATUS_CONFIG } from "../lib/status";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow, SidebarRowIconSlot } from "./SidebarRow";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";
import { WorkspaceStatusMenu } from "./WorkspaceStatusMenu";

/**
 * WorkspaceItem — Sidebar workspace row
 *
 * Layout:  [Left (flex-1)]  [Right]
 *   Left:
 *     Row 1: [Icon 20×20 | pad-left 26px] [branch name]
 *     Row 2: [pad-left 26px] [directory · status]
 *   Right:
 *     [+additions -deletions]
 *
 * Icons: working → PixelGrid generating, error → red dot, unread → gold dot.
 * Idle → no icon (26px indent).
 *
 * State: "initializing" → shimmer row with PixelGrid thinking + "Setting up..."
 */
export const WorkspaceItem = React.memo(function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive,
  onStatusChange,
}: WorkspaceItemProps) {
  const isInitializing = workspace.state === "initializing";

  // Hooks must be called unconditionally (React rules of hooks)
  const { duration } = useWorkingDuration({
    status: workspace.session_status,
    latestMessageSentAt: workspace.latest_message_sent_at,
  });

  // Initializing state: non-interactive row with loading animation
  if (isInitializing) {
    return (
      <li className="animate-[fadeInUp_0.25s_cubic-bezier(.215,.61,.355,1)]">
        <SidebarRow
          variant="workspace"
          isActive={false}
          aria-label="Workspace setting up"
          className="pointer-events-none"
        >
          <div className="flex min-w-0 flex-1 animate-[shimmer_2s_ease-in-out_infinite] flex-col gap-0.5">
            {/* Row 1: thinking icon + branch name (or placeholder) */}
            <div className="flex min-w-0 items-center gap-1.5">
              <SidebarRowIconSlot>
                <PixelGrid variant="thinking" size={14} />
              </SidebarRowIconSlot>
              <span className="text-text-disabled truncate text-base font-normal">
                {workspace.git_branch || "New workspace"}
              </span>
            </div>
            {/* Row 2: directory · status */}
            <div className="flex min-w-0 items-center gap-1.5 pl-[26px]">
              {workspace.slug && (
                <>
                  <span className="text-text-disabled truncate text-xs">{workspace.slug}</span>
                  <span className="text-text-disabled text-xs">·</span>
                </>
              )}
              <span className="text-text-muted shrink-0 text-xs">
                {match(workspace.init_stage)
                  .with("worktree", () => "Creating worktree...")
                  .with("dependencies", () => "Installing dependencies...")
                  .with("hooks", () => "Setting up environment...")
                  .with("session", () => "Finalizing...")
                  .otherwise(() => "Setting up...")}
              </span>
            </div>
          </div>
        </SidebarRow>
      </li>
    );
  }

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return `${diffMonths}mo ago`;
  };

  const displayStatus = getDisplayStatus(workspace);
  const statusConfig = STATUS_CONFIG[displayStatus];
  // Session activity icons take priority over workflow status
  const hasSessionIcon =
    displayStatus === "working" || displayStatus === "unread" || displayStatus === "error";

  const isSetupRunning = workspace.setup_status === "running";
  const isSetupFailed = workspace.setup_status === "failed";

  const statusTextClass = isSetupFailed
    ? "text-accent-red-muted"
    : isSetupRunning
      ? "text-text-muted"
      : match(displayStatus)
          .with("working", () => "text-text-tertiary")
          .with("unread", () => "text-text-secondary")
          .with("error", () => "text-accent-red-muted")
          .otherwise(() => "text-text-disabled");

  const getStatusText = (): string => {
    if (isSetupRunning) return "Installing...";
    if (isSetupFailed) return "Setup failed";
    if (workspace.state === "archived") return "Archived";
    if (!workspace.session_status) return formatTime(workspace.updated_at);

    return match(displayStatus)
      .with("idle", () => formatTime(workspace.updated_at))
      .with("unread", () => "Needs response")
      .with("working", () =>
        duration > 0 ? formatDuration(duration, false) : STATUS_CONFIG.working.labelActive
      )
      .with("error", () => STATUS_CONFIG.error.label)
      .otherwise(() => statusConfig.label);
  };

  const statusText = getStatusText();
  const showStatusDot = Boolean(workspace.slug && statusText);

  const additions = diffStats?.additions ?? 0;
  const deletions = diffStats?.deletions ?? 0;
  const hasChanges = additions > 0 || deletions > 0;

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onArchive) {
      onArchive(workspace.id);
    }
  };

  const isArchived = workspace.state === "archived";
  const canArchive = !isArchived && !!onArchive;
  const isActiveState =
    displayStatus === "working" || displayStatus === "unread" || displayStatus === "error";

  return (
    <li>
      <SidebarRow
        variant="workspace"
        isActive={isActive}
        role="button"
        tabIndex={0}
        data-workspace-id={workspace.id}
        className="cursor-pointer"
        aria-current={isActive ? "page" : undefined}
        aria-label={`Workspace ${workspace.git_branch} on ${workspace.slug}`}
        onClick={() => onClick(workspace)}
        onKeyDown={(e) => {
          if (e.key === " ") e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") onClick(workspace);
        }}
      >
        {/* Left: rows */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Row 1: icon + branch name */}
          <div className="flex min-w-0 items-center gap-1.5">
            <WorkspaceStatusMenu
              currentStatus={workspace.status}
              onStatusChange={(status) => onStatusChange?.(workspace.id, status)}
            >
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:opacity-80"
                aria-label={`Status: ${workspace.status}`}
              >
                {hasSessionIcon ? (
                  match(displayStatus)
                    .with("working", () => <PixelGrid variant="generating" size={14} />)
                    .with("error", () => <span className="bg-accent-red h-2 w-2 rounded-full" />)
                    .otherwise(() => <span className="bg-accent-gold h-2 w-2 rounded-full" />)
                ) : (
                  <WorkflowStatusIcon status={workspace.status} size={14} />
                )}
              </button>
            </WorkspaceStatusMenu>
            <span
              className={cn(
                "truncate text-base",
                isActive
                  ? "text-text-primary font-medium"
                  : isActiveState
                    ? "text-text-primary font-normal"
                    : "text-text-tertiary font-normal"
              )}
            >
              {workspace.git_branch}
            </span>
          </div>

          {/* Row 2: directory · status */}
          <div className="flex min-w-0 items-center gap-1.5 pl-[26px]">
            <span
              className={cn(
                "truncate text-xs",
                isActiveState ? "text-text-tertiary" : "text-text-disabled"
              )}
            >
              {workspace.slug}
            </span>
            {showStatusDot && (
              <span
                className={cn("text-xs", isActiveState ? "text-text-muted" : "text-text-disabled")}
              >
                ·
              </span>
            )}
            {statusText && (
              <span className={cn("flex shrink-0 items-center gap-1 text-xs", statusTextClass)}>
                {isSetupRunning && (
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                )}
                {statusText}
              </span>
            )}
          </div>
        </div>

        {/* Right: diff stats */}
        {hasChanges ? (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-xs font-medium transition-opacity",
              canArchive && "group-hover/sidebar-row:opacity-0"
            )}
          >
            {additions > 0 && (
              <NumberFlow
                value={additions}
                prefix="+"
                className={isActive ? "text-accent-green" : "text-text-muted"}
              />
            )}
            {deletions > 0 && (
              <NumberFlow
                value={deletions}
                prefix="-"
                className={isActive ? "text-accent-red" : "text-text-muted"}
              />
            )}
          </div>
        ) : null}

        {/* Archive button — hover reveal */}
        {canArchive ? (
          <button
            type="button"
            onClick={handleArchive}
            aria-label={`Archive workspace ${workspace.git_branch}`}
            title="Archive workspace"
            className={cn(
              "text-text-muted hover:text-text-secondary flex h-7 w-7 items-center justify-center rounded-lg",
              "absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity",
              "group-hover/sidebar-row:opacity-100"
            )}
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </SidebarRow>
    </li>
  );
});
