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

  // Calculate state counts for collapsed badge system
  const errorCount = repository.workspaces.filter(ws =>
    ws.session_status === 'error'
  ).length;

  const unreadCount = repository.workspaces.filter(ws =>
    (ws.unread && ws.unread > 0) ||
    (ws.session_unread && ws.session_unread > 0)
  ).length;

  const workingCount = repository.workspaces.filter(ws =>
    ws.session_status === 'working'
  ).length;

  // Determine ring color based on hierarchy: error > unread > working
  let ringColor: 'error' | 'unread' | 'working' | 'idle';
  if (errorCount > 0) ringColor = 'error';
  else if (unreadCount > 0) ringColor = 'unread';
  else if (workingCount > 0) ringColor = 'working';
  else ringColor = 'idle';

  // Active = any state that needs attention or monitoring
  const isActive = errorCount > 0 || unreadCount > 0 || workingCount > 0;
  const isIdle = !isActive;

  // For expanded state, keep existing priority status logic
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
          "group/repository-item relative flex items-center py-1",
          // Expanded: pl-3 pr-3 for spacing
          // Collapsed: px-0 with justify-center to center the badge
          sidebarExpanded && "pl-3 pr-3 hover:bg-sidebar-accent/30 rounded-md transition-colors duration-200",
          !sidebarExpanded && "px-0 overflow-visible justify-center"
        )}
      >
        {/* Expanded view: Keep in DOM, hide with CSS to avoid unmount/remount during sidebar animation */}
        <div className={cn(
          "flex items-center flex-1 gap-2",
          // Smooth fade out when collapsing, instant appearance when expanding
          "transition-opacity duration-100 ease-out",
          sidebarExpanded ? "opacity-100" : "opacity-0 pointer-events-none absolute"
        )}>
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
                      "rounded-md",
                      repoColor.bg,
                      repoColor.text
                    )}>
                      {getRepoInitials(repository.repo_name)}
                    </div>
                  );
                })()}
                <span className="truncate">
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
        </div>

        {/* Collapsed view: Keep in DOM, hide with CSS - smooth fade in with slight delay */}
        <div className={cn(
          // Delayed fade in when collapsed
          "transition-opacity duration-150 delay-50 ease-out",
          !sidebarExpanded ? "opacity-100" : "opacity-0 pointer-events-none absolute"
        )}>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              className={cn(
                // GPU-accelerated only: transform + opacity, no layout properties
                "flex items-center justify-center overflow-visible relative h-8 text-sm",
                "group/badge",
                // Force GPU acceleration with translateZ(0)
                "transform-gpu translate-z-0",
                // Collapsed mode: remove padding and let button shrink to content
                "group-data-[collapsible=icon]:!w-auto group-data-[collapsible=icon]:!h-auto group-data-[collapsible=icon]:!p-0",
                // Hover states: lift for active, opacity for idle (GPU-accelerated only)
                isActive && "hover:translate-y-[-2px] transition-transform duration-200 ease-out",
                isIdle && "hover:opacity-60 transition-opacity duration-200 ease-out"
              )}
              tooltip={(() => {
                // Rich tooltip showing full breakdown
                const parts: string[] = [];
                if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
                if (unreadCount > 0) parts.push(`${unreadCount} unread`);
                if (workingCount > 0) parts.push(`${workingCount} working`);
                const compactingCount = repository.workspaces.filter(ws => ws.session_status === 'compacting').length;
                if (compactingCount > 0) parts.push(`${compactingCount} compacting`);
                const idleCount = repository.workspaces.length - errorCount - unreadCount - workingCount - compactingCount;
                if (idleCount > 0) parts.push(`${idleCount} idle`);
                return `${repository.repo_name}${parts.length > 0 ? '\n' + parts.join(' • ') : ''}`;
              })()}
              onClick={handleClick}
            >
              <div className="relative overflow-visible flex items-center justify-center">
                {/* Spinner ring for working state - visible rotating arc shows progress */}
                {workingCount > 0 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <svg
                      className="absolute w-[36px] h-[36px] animate-[subtle-spin_2s_linear_infinite] motion-reduce:animate-none"
                      style={{ willChange: 'transform' }}
                      viewBox="0 0 36 36"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle
                        cx="18"
                        cy="18"
                        r="16"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeDasharray="40 60"
                        strokeLinecap="round"
                        className={cn(
                          "opacity-55",
                          ringColor === 'working' && "text-green-500 dark:text-green-400",
                          ringColor === 'unread' && "text-amber-500 dark:text-amber-400",
                          ringColor === 'error' && "text-red-500 dark:text-red-400"
                        )}
                      />
                    </svg>
                  </div>
                )}

                {/* Main repository badge with ring - 32px (size-8) matches shadcn design */}
                <div
                  className={cn(
                    "relative h-8 w-8 flex items-center justify-center text-xs font-semibold",
                    "rounded-[8px]",
                    "transform-gpu translate-z-0",
                    // Only transition border-color (not shadow/layout) - fast and smooth
                    "transition-[border-color,background-color] duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                    // Active repos: Full brightness with status ring
                    isActive && [
                      "bg-sidebar-accent",
                      "border-2",
                      // Ring color hierarchy: error > unread > working
                      ringColor === 'error' && "border-red-500 dark:border-red-400",
                      ringColor === 'unread' && "border-amber-500 dark:border-amber-400",
                      ringColor === 'working' && "border-green-500/70 dark:border-green-400/70"
                    ],
                    // Idle repos: Reduced presence, no ring
                    isIdle && [
                      "bg-sidebar",
                      "text-sidebar-foreground/40"
                    ]
                  )}
                  style={
                    // Use pseudo-element for glow via CSS variable (GPU-accelerated via opacity animation)
                    workingCount > 0 && isActive && ringColor === 'working' ? {
                      willChange: 'opacity',
                    } : undefined
                  }
                >
                  {/* Breathing glow using pseudo-element (GPU-accelerated) */}
                  {workingCount > 0 && isActive && ringColor === 'working' && (
                    <div
                      className="absolute inset-[-2px] rounded-[10px] pointer-events-none animate-[breathing-glow_2.5s_ease-in-out_infinite] motion-reduce:animate-none"
                      style={{
                        background: 'radial-gradient(circle, rgba(34,197,94,0.25) 0%, transparent 70%)',
                        willChange: 'opacity'
                      }}
                    />
                  )}

                  {/* Center content: working count OR initials */}
                  {workingCount > 0 ? (
                    <span className={cn(
                      "relative z-10 text-[11px] font-bold tabular-nums",
                      // Number color matches ring color for visual unity
                      ringColor === 'working' && "text-green-600 dark:text-green-400",
                      ringColor === 'unread' && "text-amber-600 dark:text-amber-400",
                      ringColor === 'error' && "text-red-600 dark:text-red-400"
                    )}>
                      {workingCount}
                    </span>
                  ) : (
                    <span className={cn(
                      "relative z-10 text-xs font-semibold",
                      // Inherit parent opacity for idle repos, full brightness for active
                      isIdle ? "text-sidebar-foreground/40" : "text-sidebar-foreground"
                    )}>
                      {getRepoInitials(repository.repo_name)}
                    </span>
                  )}
                </div>

                {/* Corner badge for unread (Slack-style notification) */}
                {unreadCount > 0 && (
                  <span
                    className={cn(
                      "absolute -top-1 -right-1",
                      "flex h-[18px] min-w-[18px] items-center justify-center",
                      "rounded-full text-[10px] font-bold px-1",
                      "z-20 border-[2px] border-sidebar",
                      "transition-all duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                      "animate-in zoom-in-50",
                      "bg-amber-500 dark:bg-amber-600 text-white",
                      "shadow-[0_2px_8px_rgba(245,158,11,0.3)]"
                    )}
                    aria-label={`${unreadCount} unread workspace${unreadCount > 1 ? 's' : ''}`}
                  >
                    {unreadCount}
                  </span>
                )}
              </div>
            </SidebarMenuButton>
          </CollapsibleTrigger>
        </div>
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
                        <span className="text-[10px] font-bold tracking-wider uppercase">
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
