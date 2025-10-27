import { useState } from "react";
import { Archive } from "lucide-react";
import { SidebarMenuSubItem } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { PulseRadiateIcon } from "@/components/pulse-radiate-icon";
import { cn } from "@/shared/lib/utils";
import { useWorkingDuration } from "@/shared/hooks";
import { useDiffStats } from "@/features/workspace/api";
import type { WorkspaceItemProps } from "../model/types";

/**
 * WorkspaceItem Component
 * Displays a single workspace with status, changes, and archive functionality
 */
export function WorkspaceItem({
  workspace,
  isActive,
  onClick,
  onArchive
}: WorkspaceItemProps) {
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

  const getStatusTextColor = (status: string | null | undefined) => {
    switch (status) {
      case "working":
        return "text-primary";
      case "idle":
        return "text-muted-foreground/70";
      case "compacting":
        return "text-warning";
      default:
        return "text-destructive";
    }
  };

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

  const isArchived = workspace.state === 'archived';
  const showArchiveButton = isHovered && !isArchived && !!onArchive;

  return (
    <SidebarMenuSubItem>
      <div
        role="button"
        tabIndex={0}
        data-workspace-id={workspace.id}
        className={cn(
          // Base layout
          "relative flex items-center justify-between gap-3 py-3 px-3 min-h-[56px]",
          "rounded-lg cursor-pointer",
          "transition-all duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",

          // State-based backgrounds - subtle surface elevation
          isActive && "bg-muted/60",
          !isActive && "hover:bg-muted/30"
        )}
        aria-current={isActive ? "page" : undefined}
        aria-label={`Workspace ${workspace.branch} on ${workspace.directory_name}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClick();
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <PulseRadiateIcon
            isActive={workspace.session_status === "working"}
            className={cn(
              "h-4 w-4 flex-shrink-0",
              getStatusTextColor(workspace.session_status)
            )}
          />
          <div className="flex flex-col min-w-0">
            {/* Branch name on top */}
            <span className="text-sm truncate">
              {workspace.branch}
            </span>
            {/* Directory name and status on bottom */}
            <div className="flex items-center gap-0 min-w-0">
              <span className="text-xs text-muted-foreground truncate">
                {workspace.directory_name}
              </span>
              <span className="text-xs text-muted-foreground/70 flex-shrink-0">・</span>
              {shouldShimmer(workspace.session_status) ? (
                <TextShimmer
                  as="span"
                  duration={2}
                  className={cn(
                    "text-xs flex-shrink-0",
                    workspace.session_status === "working"
                      ? "[--base-color:theme(colors.blue.700)] [--base-gradient-color:theme(colors.blue.300)] dark:[--base-color:theme(colors.blue.600)] dark:[--base-gradient-color:theme(colors.blue.400)]"
                      : "[--base-color:theme(colors.yellow.600)] [--base-gradient-color:theme(colors.yellow.200)] dark:[--base-color:theme(colors.yellow.700)] dark:[--base-gradient-color:theme(colors.yellow.400)]"
                  )}
                >
                  {getStatusText(workspace.session_status)}
                </TextShimmer>
              ) : (
                <span
                  className={cn(
                    "text-xs flex-shrink-0",
                    getStatusTextColor(workspace.session_status)
                  )}
                >
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
            className="h-7 px-2 text-muted-foreground hover:text-foreground"
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        ) : hasChanges ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            {additions > 0 && (
              <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-success/30 bg-success/10 text-success whitespace-nowrap">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-destructive/30 bg-destructive/10 text-destructive whitespace-nowrap">
                -{deletions}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </SidebarMenuSubItem>
  );
}
