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
import { getRepoInitials, getRepoColor } from "../lib/utils";
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
  diffStats,
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
          "group flex items-center gap-3 px-3 py-1",
          sidebarExpanded && "hover:bg-sidebar-accent/30 rounded-md transition-colors duration-200",
          !sidebarExpanded && "overflow-visible"
        )}
      >
        {sidebarExpanded ? (
          <>
            {dragHandleProps && <DragHandle {...dragHandleProps} />}
            <CollapsibleTrigger asChild>
              <button
                className="flex-1 flex items-center justify-between text-sm font-medium bg-transparent hover:bg-transparent focus:outline-none focus-visible:outline-none active:bg-transparent"
              >
                <span className="truncate">
                  {repository.repo_name}
                </span>

                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-sidebar-foreground/50 transition-transform duration-200 ease-out flex-shrink-0 motion-reduce:transition-none",
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
                      "rounded-[8px]",
                      repoColor.bg,
                      repoColor.text
                    )}>
                      {getRepoInitials(repository.repo_name)}
                    </div>
                  );
                })()}
                {hasRunningWorkspace && (
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
        <SidebarMenuSub className="border-l-0 mx-0 px-0">
          {/* New Workspace Button - At Top, Compact Height */}
          {sidebarExpanded && (
            <SidebarMenuSubItem className="mb-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNewWorkspace(repository.repo_id)}
                className={cn(
                  "w-full h-8 px-3 -translate-x-px",
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
          )}

          {repository.workspaces.map((workspace) => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              isActive={workspace.id === selectedWorkspaceId}
              diffStats={diffStats[workspace.id]}
              onClick={() => onWorkspaceClick(workspace)}
              onArchive={onArchive}
            />
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}
