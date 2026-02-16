import React from "react";
import { match } from "ts-pattern";
import { Archive } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { PixelGrid } from "@/features/session/ui/PixelGrid";
import { getDisplayStatus, STATUS_CONFIG } from "../lib/status";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow, SidebarRowIconSlot } from "./SidebarRow";

/**
 * Whether this status shows an icon in the 20x20 slot.
 * working → PixelGrid generating, unread → gold dot, error → red dot.
 * Only idle shows no icon (26px padding).
 */
const hasStatusIcon = (status: string) =>
  status === "working" || status === "unread" || status === "error";

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
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 animate-[shimmer_2s_ease-in-out_infinite]">
            {/* Row 1: thinking icon + branch name (or placeholder) */}
            <div className="flex min-w-0 items-center gap-1.5">
              <SidebarRowIconSlot>
                <PixelGrid variant="thinking" size={14} />
              </SidebarRowIconSlot>
              <span className="text-text-disabled truncate text-[13px] font-normal">
                {workspace.branch || "New workspace"}
              </span>
            </div>
            {/* Row 2: directory · status */}
            <div className="flex min-w-0 items-center gap-1.5 pl-[26px]">
              {workspace.directory_name && (
                <>
                  <span className="text-text-disabled truncate text-xs">
                    {workspace.directory_name}
                  </span>
                  <span className="text-text-disabled text-xs">·</span>
                </>
              )}
              <span className="text-text-muted shrink-0 text-xs">Setting up...</span>
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
  const showIcon = hasStatusIcon(displayStatus);
  // 20px icon + 6px gap = 26px indent for rows without an icon
  const rowIndent = "pl-[26px]";

  const statusTextClass = match(displayStatus)
    .with("working", () => "text-text-tertiary")
    .with("unread", () => "text-text-secondary")
    .with("error", () => "text-accent-red-muted")
    .otherwise(() => "text-text-disabled");

  const getStatusText = () => {
    if (workspace.state === "archived" || !workspace.session_status) return "Archived";
    if (displayStatus === "idle") return formatTime(workspace.updated_at);
    if (displayStatus === "unread") return "Needs response";
    if (displayStatus === "working") {
      return duration > 0 ? formatDuration(duration, false) : STATUS_CONFIG.working.labelActive;
    }
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
        aria-label={`Workspace ${workspace.branch} on ${workspace.directory_name}`}
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
          <div className={cn("flex min-w-0 items-center gap-1.5", !showIcon && rowIndent)}>
            {showIcon && (
              <SidebarRowIconSlot>
                {displayStatus === "working" ? (
                  <PixelGrid variant="generating" size={14} />
                ) : displayStatus === "error" ? (
                  <span className="bg-accent-red h-2 w-2 rounded-full" />
                ) : (
                  /* unread: gold dot */
                  <span className="bg-accent-gold h-2 w-2 rounded-full" />
                )}
              </SidebarRowIconSlot>
            )}
            <span
              className={cn(
                "truncate text-[13px]",
                isActive
                  ? "text-text-primary font-medium"
                  : isActiveState
                    ? "text-text-primary font-normal"
                    : "text-text-tertiary font-normal"
              )}
            >
              {workspace.branch}
            </span>
          </div>

          {/* Row 2: directory · status */}
          <div className={cn("flex min-w-0 items-center gap-1.5", rowIndent)}>
            <span
              className={cn(
                "truncate text-xs",
                isActiveState ? "text-text-tertiary" : "text-text-disabled"
              )}
            >
              {workspace.directory_name}
            </span>
            {showStatusDot && (
              <span
                className={cn("text-xs", isActiveState ? "text-text-muted" : "text-text-disabled")}
              >
                ·
              </span>
            )}
            {statusText && (
              <span className={cn("shrink-0 text-xs", statusTextClass)}>{statusText}</span>
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
