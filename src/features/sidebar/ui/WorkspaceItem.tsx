import { useState } from "react";
import { Archive } from "lucide-react";
import { SidebarMenuSubItem } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { PulseRadiateIcon } from "@/components/pulse-radiate-icon";
import { cn } from "@/shared/lib/utils";
import { useWorkingDuration } from "@/shared/hooks";
import { useDiffStats } from "@/features/workspace/api";
import { getDisplayStatus, STATUS_CONFIG } from "../lib/status";
import type { WorkspaceItemProps } from "../model/types";

/**
 * WorkspaceItem Component
 * Displays a single workspace with status, changes, and archive functionality
 */
export function WorkspaceItem({ workspace, isActive, onClick, onArchive }: WorkspaceItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: workspace.session_status,
    latestMessageSentAt: workspace.latest_message_sent_at,
  });

  // Fetch diff stats with conditional polling based on session status
  const { data: diffStats } = useDiffStats(workspace.id, workspace.session_status);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${diffDays}d`;
  };

  const getStatusText = (status: string | null | undefined) => {
    if (!status) return "Archived";
    if (status === "idle") return formatTime(workspace.updated_at);

    // Show duration for working status
    if (status === "working" && formattedDuration) {
      return formattedDuration;
    }

    const capitalized = status.charAt(0).toUpperCase() + status.slice(1);
    return shouldShimmer(status) ? `${capitalized}...` : capitalized;
  };

  // Get the display status (handles unread, working, idle, etc.)
  const displayStatus = getDisplayStatus(workspace);
  const statusConfig = STATUS_CONFIG[displayStatus];

  const shouldShimmer = (status: string | null | undefined) => {
    return status === "working" || status === "compacting";
  };

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
  const showArchiveButton = isHovered && !isArchived && !!onArchive;

  return (
    <SidebarMenuSubItem>
      <div
        role="button"
        tabIndex={0}
        data-workspace-id={workspace.id}
        className={cn(
          // Base layout
          "relative mb-1 flex min-h-[56px] items-center justify-between gap-3 px-2 py-3",
          "cursor-pointer rounded-lg",
          "transition-all duration-[80ms] ease-out",

          // State-based backgrounds - subtle surface elevation
          isActive && "bg-foreground/5",
          !isActive && "hover:bg-foreground/5"
        )}
        aria-current={isActive ? "page" : undefined}
        aria-label={`Workspace ${workspace.branch} on ${workspace.directory_name}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === " ") e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") onClick();
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="flex min-w-0 items-center gap-3">
          <PulseRadiateIcon
            isActive={workspace.session_status === "working"}
            className={cn("h-4 w-4 shrink-0", statusConfig.text)}
          />
          <div className="flex min-w-0 flex-col">
            {/* Branch name on top */}
            <span className="text-foreground truncate text-sm font-normal">{workspace.branch}</span>
            {/* Directory name and status on bottom */}
            <div className="flex min-w-0 items-center gap-0">
              <span className="text-muted-foreground/60 truncate text-xs">
                {workspace.directory_name}
              </span>
              <span className="text-muted-foreground/60 shrink-0 text-xs">・</span>
              {shouldShimmer(workspace.session_status) ? (
                <TextShimmer
                  as="span"
                  duration={2}
                  className="shrink-0 text-xs"
                  color={
                    workspace.session_status === "working"
                      ? "var(--status-working)"
                      : "var(--status-compacting)"
                  }
                  gradientColor={
                    workspace.session_status === "working"
                      ? "color-mix(in oklch, var(--status-working) 60%, white)"
                      : "color-mix(in oklch, var(--status-compacting) 60%, white)"
                  }
                >
                  {getStatusText(workspace.session_status)}
                </TextShimmer>
              ) : (
                <span className={cn("shrink-0 text-xs", statusConfig.text)}>
                  {getStatusText(workspace.session_status)}
                </span>
              )}
            </div>
          </div>
        </div>
        {showArchiveButton ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleArchive}
            aria-label={`Archive workspace ${workspace.branch}`}
            title="Archive workspace"
            className="text-muted-foreground hover:text-foreground h-7 px-2"
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        ) : hasChanges ? (
          /* File changes badge for workspaces with changes */
          <div className="flex shrink-0 items-center gap-1 rounded border px-1">
            {additions > 0 && (
              <span className="text-2xs text-success inline-flex items-center rounded py-0.5 font-mono font-normal whitespace-nowrap">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-2xs text-destructive inline-flex items-center rounded py-0.5 font-mono font-normal whitespace-nowrap">
                -{deletions}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </SidebarMenuSubItem>
  );
}
