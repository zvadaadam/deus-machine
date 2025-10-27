import { ChevronDown, Plus } from "lucide-react";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { getRepoInitials, getRepoColor, getCleanRepoName } from "../lib/utils";
import { getRepoUnreadCount, getRepoPriorityStatus, STATUS_CONFIG, sortByStatusPriority, groupByStatus, getDisplayStatus } from "../lib/status";
import type { RepositoryItemProps } from "../model/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { DragHandle } from "./DragHandle";

/**
 * RepositoryItem Component
 * Displays a single repository with its workspaces and controls
 */
export function RepositoryItem({
  repository,
  isCollapsed,
  selectedWorkspaceId,
  onToggleCollapse,
  onWorkspaceClick,
  onNewWorkspace,
  onArchive,
  sidebarExpanded,
  dragHandleProps,
}: RepositoryItemProps) {
  const { toggleSidebar } = useSidebar();
  const hasRunningWorkspace = repository.workspaces.some(
    (ws) => ws.session_status === "working"
  );

  // Calculate unread count and priority status for badges
  const unreadCount = getRepoUnreadCount(repository.workspaces);
  const priorityStatus = getRepoPriorityStatus(repository.workspaces);
  const statusConfig = STATUS_CONFIG[priorityStatus];

  const handleClick = (e: React.MouseEvent) => {
    if (!sidebarExpanded) {
      // When sidebar is collapsed, expand it and open the repository
      e.preventDefault(); // Prevent default collapsible behavior
      toggleSidebar();
      // Use setTimeout to ensure sidebar expands before toggling repository
      setTimeout(() => {
        if (isCollapsed) {
          onToggleCollapse();
        }
      }, 100);
    }
    // When expanded, let CollapsibleTrigger handle it naturally
  };

  return (
    <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse()}>
      <SidebarMenuItem
        data-state={isCollapsed ? "closed" : "open"}
        className={cn(
          "group/repository-item relative flex items-center pl-3 pr-3 py-1",
          sidebarExpanded && "hover:bg-sidebar-accent/30 rounded-md transition-colors duration-200",
          !sidebarExpanded && "overflow-visible"
        )}
      >
        {sidebarExpanded ? (
          <>
            {dragHandleProps && <DragHandle {...dragHandleProps} />}
            <CollapsibleTrigger asChild>
              <button
                className="flex-1 flex items-center justify-between text-sm font-medium bg-transparent hover:bg-transparent focus:outline-none focus-visible:outline-none active:bg-transparent gap-2"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {(() => {
                    const repoColor = getRepoColor(repository.repo_name);
                    return (
                      <div className={cn(
                        "h-6 w-6 flex items-center justify-center text-[10px] font-semibold flex-shrink-0",
                        "rounded-md transition-transform duration-[80ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                        repoColor.bg,
                        repoColor.text
                      )}>
                        {getRepoInitials(repository.repo_name)}
                      </div>
                    );
                  })()}
                  <span className="truncate transition-opacity duration-[80ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]">
                    {getCleanRepoName(repository.repo_name)}
                  </span>
                </div>

                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-sidebar-foreground/50 transition-transform duration-[180ms] delay-[60ms] ease-[cubic-bezier(0.165,0.84,0.44,1)] flex-shrink-0 motion-reduce:transition-none",
                    isCollapsed && "-rotate-90"
                  )}
                />
              </button>
            </CollapsibleTrigger>
          </>
        ) : (
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              className="w-full flex items-center px-0 py-3 justify-center overflow-visible"
              tooltip={repository.repo_name}
              onClick={handleClick}
            >
              <div className="relative overflow-visible">
                {(() => {
                  const repoColor = getRepoColor(repository.repo_name);
                  return (
                    <div className={cn(
                      "h-9 w-9 flex items-center justify-center text-xs font-semibold",
                      "rounded-[8px] transition-all duration-[180ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                      "border-2",
                      repoColor.bg,
                      repoColor.text,
                      // Status-based border color (visual priority indicator)
                      statusConfig.border,
                      // Pulse effect for active states
                      statusConfig.pulse && "animate-pulse"
                    )}>
                      {getRepoInitials(repository.repo_name)}
                    </div>
                  );
                })()}
                {/* Unread badge - highest priority indicator */}
                {unreadCount > 0 && (
                  <span
                    className={cn(
                      "absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-semibold px-1.5 z-20 border-2 border-sidebar",
                      statusConfig.badge
                    )}
                    aria-label={`${unreadCount} unread`}
                  >
                    {unreadCount}
                  </span>
                )}
                {/* Running workspace indicator (pulsing dot) - secondary indicator */}
                {hasRunningWorkspace && unreadCount === 0 && (
                  <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 z-10">
                    <span className="animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                  </span>
                )}
              </div>
            </SidebarMenuButton>
          </CollapsibleTrigger>
        )}
      </SidebarMenuItem>
      <CollapsibleContent>
        <SidebarMenuSub className="border-l-0 mx-0 px-0 translate-x-0">
          {sidebarExpanded && (() => {
            // Sort workspaces by priority, then group by status
            const sortedWorkspaces = sortByStatusPriority(repository.workspaces);
            const groupedWorkspaces = groupByStatus(sortedWorkspaces);

            // Define section order and labels
            const sections: Array<{ status: keyof typeof groupedWorkspaces, label: string, emoji: string }> = [
              { status: 'error', label: 'ERRORS', emoji: '🔴' },
              { status: 'unread', label: 'NEEDS REVIEW', emoji: '🟡' },
              { status: 'working', label: 'WORKING', emoji: '🟢' },
              { status: 'compacting', label: 'MAINTENANCE', emoji: '🟣' },
              { status: 'idle', label: 'IDLE', emoji: '⚪' },
            ];

            return (
              <>
                {/* New Workspace Button - At Top */}
                <SidebarMenuSubItem className="mb-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onNewWorkspace(repository.repo_id)}
                    className={cn(
                      "w-full",
                      "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent",
                      "transition-colors duration-200 ease-out"
                    )}
                  >
                    <div className="flex items-center gap-3 w-full">
                      <Plus className="h-4 w-4 flex-shrink-0" />
                      <span className="text-sm">New Workspace</span>
                    </div>
                  </Button>
                </SidebarMenuSubItem>

                {/* Render sections in priority order */}
                {sections.map(({ status, label, emoji }) => {
                  const workspacesInSection = groupedWorkspaces[status];
                  if (!workspacesInSection || workspacesInSection.length === 0) {
                    return null;
                  }

                  const sectionConfig = STATUS_CONFIG[status];

                  return (
                    <div key={status} className="mb-3">
                      {/* Section Header */}
                      <div className="px-3 py-2 flex items-center gap-2">
                        <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color: `var(--${status}-color, currentColor)` }}>
                          <span className={cn("mr-1", sectionConfig.text)}>{emoji}</span>
                          <span className={sectionConfig.text}>{label}</span>
                        </span>
                        <span className={cn("text-[10px] font-semibold", sectionConfig.text)}>
                          {workspacesInSection.length}
                        </span>
                      </div>

                      {/* Workspaces in Section */}
                      {workspacesInSection.map((workspace) => (
                        <WorkspaceItem
                          key={workspace.id}
                          workspace={workspace}
                          isActive={workspace.id === selectedWorkspaceId}
                          onClick={() => onWorkspaceClick(workspace)}
                          onArchive={onArchive}
                        />
                      ))}
                    </div>
                  );
                })}
              </>
            );
          })()}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}
