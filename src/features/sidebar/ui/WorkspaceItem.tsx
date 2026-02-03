import React from "react";
import { Archive, CircleDot, Eye, GitBranch, GitPullRequest } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { PixelGrid } from "@/features/session/ui/PixelGrid";
import { getDisplayStatus, STATUS_CONFIG } from "../lib/status";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow, SidebarRowIconSlot, SidebarRowMain } from "./SidebarRow";

/** Returns the appropriate status icon as a JSX element (not a component type)
 *  so React reconciles correctly without remounting the DOM node each render. */
function getStatusIcon(status: string, isArchived: boolean, className: string) {
  if (isArchived) return <Archive className={className} />;
  switch (status) {
    case "error":
      return <CircleDot className={className} />;
    case "unread":
      return <Eye className={className} />;
    case "compacting":
      return <GitPullRequest className={className} />;
    case "idle":
    default:
      return <GitBranch className={className} />;
  }
}

/**
 * WorkspaceItem Component
 * Displays a single workspace with status, changes, and archive functionality
 */
export const WorkspaceItem = React.memo(function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive,
}: WorkspaceItemProps) {
  // Track working duration (compact format — no tenths in sidebar)
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

  // Get the display status (handles unread, working, idle, etc.)
  const displayStatus = getDisplayStatus(workspace);
  const statusConfig = STATUS_CONFIG[displayStatus];
  const statusTextClass = statusConfig.text;

  const getStatusText = () => {
    if (workspace.state === "archived" || !workspace.session_status) return "Archived";
    if (displayStatus === "idle") return formatTime(workspace.updated_at);
    if (displayStatus === "unread") return "Needs review";
    if (displayStatus === "working") {
      return duration > 0 ? formatDuration(duration, false) : STATUS_CONFIG.working.labelActive;
    }
    if (displayStatus === "compacting") return STATUS_CONFIG.compacting.labelActive;
    if (displayStatus === "error") return STATUS_CONFIG.error.label;
    return STATUS_CONFIG[displayStatus].label;
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
            ) : (
              getStatusIcon(
                displayStatus,
                isArchived,
                cn("h-4 w-4", isArchived ? "text-muted-foreground" : statusTextClass)
              )
            )}
          </SidebarRowIconSlot>
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] gap-x-3">
            <span className="text-foreground truncate text-[13px] font-normal">
              {workspace.branch}
            </span>
            {hasChanges ? (
              <div
                className={cn(
                  "flex items-center gap-2 self-start justify-self-end pr-1 text-xs font-medium transition-opacity",
                  canArchive && "group-hover/sidebar-row:opacity-0"
                )}
              >
                {additions > 0 && <span className="text-success">+{additions}</span>}
                {deletions > 0 && <span className="text-destructive">-{deletions}</span>}
              </div>
            ) : null}
            <div className="col-span-2 flex min-w-0 items-center gap-1">
              <span className="text-muted-foreground/70 truncate text-xs">
                {workspace.directory_name}
              </span>
              {showStatusDot && <span className="text-muted-foreground/60 text-xs">·</span>}
              {statusText && (
                <span className={cn("shrink-0 text-xs", statusTextClass)}>{statusText}</span>
              )}
            </div>
          </div>
        </SidebarRowMain>
        {canArchive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleArchive}
            aria-label={`Archive workspace ${workspace.branch}`}
            title="Archive workspace"
            className={cn(
              "text-muted-foreground hover:text-foreground h-7 px-2",
              "absolute top-2 right-1 opacity-0 transition-opacity",
              "group-hover/sidebar-row:opacity-100"
            )}
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </SidebarRow>
    </li>
  );
});
