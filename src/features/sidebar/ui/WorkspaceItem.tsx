import React from "react";
import {
  AlertTriangle,
  Archive,
  Eye,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Circle,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { PixelGrid } from "@/features/session/ui/PixelGrid";
import { getDisplayStatus, STATUS_CONFIG } from "../lib/status";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow, SidebarRowIconSlot, SidebarRowMain } from "./SidebarRow";

/**
 * Status icon — V2: Jony Ive (refined)
 *
 * Shape communicates meaning, not color. Neutral gray icons.
 * working    → PixelGrid (handled separately)
 * unread     → Circle (filled, small)
 * error      → AlertTriangle (shape = warning)
 * compacting → GitPullRequest
 * idle       → GitPullRequest
 */
function getStatusIcon(status: string, isArchived: boolean, className: string) {
  if (isArchived) return <Archive className={className} />;
  switch (status) {
    case "error":
      return <AlertTriangle className={className} />;
    case "unread":
      return <Circle className={cn(className, "fill-current")} />;
    case "compacting":
      return <GitPullRequest className={className} />;
    case "idle":
    default:
      return <GitPullRequest className={className} />;
  }
}

/**
 * WorkspaceItem — V2: Jony Ive
 *
 * Two-row layout inside a SidebarRow:
 *   Row 1: [StatusIcon] [branch name]     [+713 -2]
 *   Row 2:              [directory · status]
 *
 * Selected: bg-elevated, text-primary
 * Normal: text-primary (active items), text-tertiary (idle)
 * Diff stats: accent-green-muted / accent-red-muted (muted in non-selected)
 */
export const WorkspaceItem = React.memo(function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive,
}: WorkspaceItemProps) {
  const { duration } = useWorkingDuration({
    status: workspace.session_status,
    latestMessageSentAt: workspace.latest_message_sent_at,
  });

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const displayStatus = getDisplayStatus(workspace);
  const statusConfig = STATUS_CONFIG[displayStatus];

  // Neutral gray icons — shape communicates meaning, not color (Jony Ive)
  const statusIconClass = (() => {
    if (workspace.state === "archived") return "text-text-disabled";
    switch (displayStatus) {
      case "unread":
        return "text-text-secondary";
      case "error":
        return "text-text-tertiary";
      case "compacting":
        return "text-text-muted";
      default:
        return "text-text-muted";
    }
  })();

  const statusTextClass = (() => {
    switch (displayStatus) {
      case "working":
        return "text-accent-blue";
      case "unread":
        return "text-accent-gold";
      case "error":
        return "text-accent-red";
      case "compacting":
        return "text-accent-blue";
      default:
        return "text-text-muted";
    }
  })();

  const getStatusText = () => {
    if (workspace.state === "archived" || !workspace.session_status) return "Archived";
    if (displayStatus === "idle") return formatTime(workspace.updated_at);
    if (displayStatus === "unread") return "Needs review";
    if (displayStatus === "working") {
      return duration > 0 ? formatDuration(duration, false) : STATUS_CONFIG.working.labelActive;
    }
    if (displayStatus === "compacting") return STATUS_CONFIG.compacting.labelActive;
    if (displayStatus === "error") return STATUS_CONFIG.error.label;
    return statusConfig.label;
  };

  const statusText = getStatusText();
  const showStatusDot = Boolean(workspace.directory_name && statusText);

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
        aria-label={`Workspace ${workspace.branch} on ${workspace.directory_name}`}
        onClick={() => onClick(workspace)}
        onKeyDown={(e) => {
          if (e.key === " ") e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") onClick(workspace);
        }}
      >
        <SidebarRowMain indent="workspace" className="items-start">
          <SidebarRowIconSlot className="mt-0.5">
            {displayStatus === "working" ? (
              <PixelGrid variant="generating" size={14} />
            ) : displayStatus === "unread" ? (
              <Circle className={cn("h-2 w-2", statusIconClass, "fill-current")} />
            ) : (
              getStatusIcon(displayStatus, isArchived, cn("h-3.5 w-3.5", statusIconClass))
            )}
          </SidebarRowIconSlot>
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] gap-x-3 gap-y-0.5">
            {/* Row 1: branch name */}
            <span
              className={cn(
                "truncate text-[13px]",
                isActive
                  ? "text-text-primary font-medium"
                  : displayStatus === "idle" || displayStatus === "compacting"
                    ? "text-text-tertiary font-normal"
                    : "text-text-primary font-normal"
              )}
            >
              {workspace.branch}
            </span>

            {/* Row 1 right: diff stats */}
            {hasChanges ? (
              <div
                className={cn(
                  "flex items-center gap-1.5 self-start justify-self-end text-xs font-medium transition-opacity",
                  canArchive && "group-hover/sidebar-row:opacity-0"
                )}
              >
                {additions > 0 && (
                  <span className={isActive ? "text-accent-green" : "text-accent-green-muted"}>
                    +{additions}
                  </span>
                )}
                {deletions > 0 && (
                  <span className={isActive ? "text-accent-red" : "text-accent-red-muted"}>
                    -{deletions}
                  </span>
                )}
              </div>
            ) : null}

            {/* Row 2: directory · status */}
            <div className="col-span-2 flex min-w-0 items-center gap-1.5">
              <span className="text-text-muted truncate text-xs">{workspace.directory_name}</span>
              {showStatusDot && <span className="text-text-muted text-xs">·</span>}
              {statusText && (
                <span className={cn("shrink-0 text-xs", statusTextClass)}>{statusText}</span>
              )}
            </div>
          </div>
        </SidebarRowMain>

        {/* Archive button — hover reveal */}
        {canArchive ? (
          <button
            type="button"
            onClick={handleArchive}
            aria-label={`Archive workspace ${workspace.branch}`}
            title="Archive workspace"
            className={cn(
              "text-text-muted hover:text-text-secondary flex h-7 w-7 items-center justify-center rounded-md",
              "absolute top-2 right-1 opacity-0 transition-opacity",
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
