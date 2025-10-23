import { useState } from "react";
import { GitBranch, Loader2, Archive } from "lucide-react";
import { SidebarMenuSubItem } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { cn } from "@/shared/lib/utils";
import type { WorkspaceItemProps } from "../model/types";

/**
 * WorkspaceItem Component
 * Displays a single workspace with status, changes, and archive functionality
 */
export function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive
}: WorkspaceItemProps) {
  const [isHovered, setIsHovered] = useState(false);

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
        className={cn(
          "grid grid-cols-[1fr_auto] items-center gap-2 py-3 pr-2.5 min-h-[56px] rounded-lg cursor-pointer transition-[background-color,border-color] duration-200 ease-out",
          isActive
            ? "bg-primary/10 border-l-[3px] border-l-primary elevation-2 pl-2"
            : "hover:bg-sidebar-accent/60 hover:elevation-1 border-l-[3px] border-l-transparent pl-2"
        )}
        aria-current={isActive ? "page" : undefined}
        aria-label={`Workspace ${workspace.branch} on ${workspace.directory_name}`}
        onClick={onClick}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          {workspace.session_status === "working" ? (
            <Loader2
              className="h-4 w-4 flex-shrink-0 text-primary/80 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <GitBranch
              className={cn(
                "h-4 w-4 flex-shrink-0",
                getStatusTextColor(workspace.session_status)
              )}
            />
          )}
          <div className="flex flex-col min-w-0 gap-0.5">
            {/* Branch name on top */}
            <span className="text-sm font-medium truncate">
              {workspace.branch}
            </span>
            {/* Directory name and status on bottom */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-muted-foreground truncate">
                {workspace.directory_name}
              </span>
              <span className="text-xs text-muted-foreground/70 flex-shrink-0">•</span>
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
