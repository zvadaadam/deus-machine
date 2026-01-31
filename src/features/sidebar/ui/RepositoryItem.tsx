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
import { getRepoInitials, getCleanRepoName } from "../lib/utils";
import {
  getRepoUnreadCount,
  getRepoPriorityStatus,
  STATUS_CONFIG,
  sortByStatusPriority,
  groupByStatus,
  getDisplayStatus,
} from "../lib/status";
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
  const hasRunningWorkspace = repository.workspaces.some((ws) => ws.session_status === "working");

  // Calculate state counts for collapsed badge system
  const errorCount = repository.workspaces.filter((ws) => ws.session_status === "error").length;

  const unreadCount = repository.workspaces.filter(
    (ws) => (ws.unread && ws.unread > 0) || (ws.session_unread && ws.session_unread > 0)
  ).length;

  const workingCount = repository.workspaces.filter((ws) => ws.session_status === "working").length;

  // Determine ring color based on hierarchy: error > unread > working
  let ringColor: "error" | "unread" | "working" | "idle";
  if (errorCount > 0) ringColor = "error";
  else if (unreadCount > 0) ringColor = "unread";
  else if (workingCount > 0) ringColor = "working";
  else ringColor = "idle";

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
          "group/repository-item relative flex items-center",
          // Expanded: px-2 for cleaner dense spacing
          // Collapsed: px-0 with justify-center to center the badge
          sidebarExpanded && "rounded-md px-2 py-2",
          !sidebarExpanded && "justify-center overflow-visible px-0"
        )}
      >
        {/* Expanded view: Keep in DOM, hide with CSS to avoid unmount/remount during sidebar animation */}
        <div
          className={cn(
            "flex flex-1 items-center gap-2",
            // Smooth fade out when collapsing, instant appearance when expanding
            "transition-opacity duration-100 ease-out",
            sidebarExpanded ? "opacity-100" : "pointer-events-none absolute opacity-0"
          )}
        >
          {dragHandleProps && <DragHandle {...dragHandleProps} />}
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="hover:bg-foreground/5 -m-2 h-auto flex-1 justify-between gap-2 rounded-md p-2 text-sm font-medium transition-colors duration-200"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{getCleanRepoName(repository.repo_name)}</span>
                {/* Status indicators when collapsed */}
                {isCollapsed &&
                  (() => {
                    const unreadCount = getRepoUnreadCount(repository.workspaces);
                    const hasWorking = repository.workspaces.some(
                      (w) => w.session_status === "working"
                    );

                    return (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {/* Unread indicator - amber dot */}
                        {unreadCount > 0 && (
                          <div
                            className="bg-status-unread h-2 w-2 rounded-full"
                            title={`${unreadCount} unread`}
                          />
                        )}
                        {/* Working indicator - primary dot */}
                        {hasWorking && (
                          <div className="bg-primary h-2 w-2 rounded-full" title="Working" />
                        )}
                      </div>
                    );
                  })()}
              </div>

              <ChevronDown
                className={cn(
                  "text-sidebar-foreground/60 h-4 w-4 shrink-0 transition-transform delay-[60ms] duration-[180ms] ease-out motion-reduce:transition-none",
                  isCollapsed && "-rotate-90"
                )}
              />
            </Button>
          </CollapsibleTrigger>
        </div>

        {/* Collapsed view: Keep in DOM, hide with CSS - smooth fade in with slight delay */}
        <div
          className={cn(
            // Delayed fade in when collapsed
            "transition-opacity delay-50 duration-150 ease-out",
            !sidebarExpanded ? "opacity-100" : "pointer-events-none absolute opacity-0"
          )}
        >
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              className={cn(
                // GPU-accelerated only: transform + opacity, no layout properties
                "relative flex h-8 items-center justify-center overflow-visible text-sm",
                "group/badge",
                // Force GPU acceleration with translateZ(0)
                "translate-z-0 transform-gpu",
                // Hover states: lift for active, opacity for idle (GPU-accelerated only)
                isActive && "transition-transform duration-200 ease-out hover:translate-y-[-2px]",
                isIdle && "transition-opacity duration-200 ease-out hover:opacity-60"
              )}
              tooltip={{
                children: (() => {
                  // Build status parts: errors, needs review, working (no idle)
                  const parts: string[] = [];
                  if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
                  if (unreadCount > 0) parts.push(`${unreadCount} needs review`);
                  if (workingCount > 0) parts.push(`${workingCount} working`);

                  return (
                    <div className="flex flex-col gap-1.5">
                      <span className="font-medium">{repository.repo_name}</span>
                      {parts.length > 0 && <span className="opacity-60">{parts.join(" • ")}</span>}
                    </div>
                  );
                })(),
              }}
              onClick={handleClick}
            >
              <div className="relative flex items-center justify-center overflow-visible">
                {/* Spinner ring for working state - visible rotating arc shows progress */}
                {workingCount > 0 && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <svg
                      className="animate-subtle-spin absolute h-[36px] w-[36px] motion-reduce:animate-none"
                      style={{ willChange: "transform" }}
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
                          "opacity-60",
                          ringColor === "working" && "text-status-working",
                          ringColor === "unread" && "text-status-unread",
                          ringColor === "error" && "text-destructive"
                        )}
                      />
                    </svg>
                  </div>
                )}

                {/* Main repository badge with ring - 32px (size-8) matches shadcn design */}
                <div
                  className={cn(
                    "relative flex h-8 w-8 items-center justify-center text-xs font-medium",
                    "rounded-lg",
                    "translate-z-0 transform-gpu",
                    // Only transition border-color (not shadow/layout) - fast and smooth
                    "transition-[border-color,background-color] duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                    // Active repos: Full brightness with status ring
                    isActive && [
                      "bg-foreground/5",
                      "border-2",
                      // Ring color hierarchy: error > unread > working
                      ringColor === "error" && "border-destructive",
                      ringColor === "unread" && "border-status-unread",
                      ringColor === "working" && "border-status-working/60",
                    ],
                    // Idle repos: Reduced presence, no ring
                    isIdle && ["bg-sidebar", "text-sidebar-foreground/30"]
                  )}
                  style={
                    // Use pseudo-element for glow via CSS variable (GPU-accelerated via opacity animation)
                    workingCount > 0 && isActive && ringColor === "working"
                      ? {
                          willChange: "opacity",
                        }
                      : undefined
                  }
                >
                  {/* Breathing glow using pseudo-element (GPU-accelerated) */}
                  {workingCount > 0 && isActive && ringColor === "working" && (
                    <div
                      className="animate-breathing-glow pointer-events-none absolute inset-[-2px] rounded-[10px] motion-reduce:animate-none"
                      style={{
                        background:
                          "radial-gradient(circle, color-mix(in oklch, var(--status-working) 25%, transparent) 0%, transparent 70%)",
                        willChange: "opacity",
                      }}
                    />
                  )}

                  {/* Center content: working count OR initials */}
                  {workingCount > 0 ? (
                    <span
                      className={cn(
                        "relative z-10 text-xs font-bold tabular-nums",
                        // Number color matches ring color for visual unity
                        ringColor === "working" && "text-status-working",
                        ringColor === "unread" && "text-status-unread",
                        ringColor === "error" && "text-destructive"
                      )}
                    >
                      {workingCount}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "relative z-10 text-xs font-medium",
                        // Inherit parent opacity for idle repos, full brightness for active
                        isIdle ? "text-sidebar-foreground/30" : "text-sidebar-foreground"
                      )}
                    >
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
                      "text-2xs rounded-full px-1 font-bold",
                      "border-sidebar z-20 border-2",
                      "transition-all duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)]",
                      "animate-in zoom-in-50",
                      "bg-status-unread text-status-unread-fg",
                      "shadow-[0_2px_8px_color-mix(in_oklch,var(--status-unread)_30%,transparent)]"
                    )}
                    aria-label={`${unreadCount} unread workspace${unreadCount > 1 ? "s" : ""}`}
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
        <SidebarMenuSub className="mx-0 gap-0 border-l-0 px-0 py-0">
          {sidebarExpanded &&
            (() => {
              // Sort workspaces by priority, then group by status
              const sortedWorkspaces = sortByStatusPriority(repository.workspaces);
              const groupedWorkspaces = groupByStatus(sortedWorkspaces);

              // Define section order and labels
              const sections: Array<{
                status: keyof typeof groupedWorkspaces;
                label: string;
              }> = [
                { status: "error", label: "ERRORS" },
                { status: "unread", label: "NEEDS REVIEW" },
                { status: "working", label: "WORKING" },
                { status: "compacting", label: "MAINTENANCE" },
                { status: "idle", label: "IDLE" },
              ];

              return (
                <>
                  {/* New Workspace Button - At Top */}
                  <SidebarMenuSubItem className="my-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onNewWorkspace(repository.repo_id)}
                      className={cn(
                        "w-full px-2",
                        "text-muted-foreground/60 hover:text-muted-foreground hover:bg-foreground/5",
                        "transition-colors duration-200 ease-out"
                      )}
                    >
                      <div className="flex w-full items-center gap-3">
                        <Plus className="h-4 w-4 shrink-0" />
                        <span className="text-sm font-normal">New Workspace</span>
                      </div>
                    </Button>
                  </SidebarMenuSubItem>

                  {/* Render sections in priority order */}
                  {sections.map(({ status, label }) => {
                    const workspacesInSection = groupedWorkspaces[status];
                    if (!workspacesInSection || workspacesInSection.length === 0) {
                      return null;
                    }

                    const sectionConfig = STATUS_CONFIG[status];

                    return (
                      <div key={status}>
                        {/* Section Header */}
                        <div className="flex items-center px-2 py-2">
                          <span
                            className={cn("text-2xs font-mono tracking-wider", sectionConfig.text)}
                          >
                            {label}
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
