import { ChevronDown, Plus } from "lucide-react";
import { SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";
import {
  getRepoUnreadCount,
  getStatusCounts,
  STATUS_CONFIG,
  sortByStatusPriority,
  groupByStatus,
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
  return (
    <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse()}>
      <SidebarMenuItem
        data-state={isCollapsed ? "closed" : "open"}
        className="group/repository-item relative flex items-center rounded-md px-2 py-2"
      >
        <div className="flex flex-1 items-center gap-2">
          {dragHandleProps && <DragHandle {...dragHandleProps} />}
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="hover:bg-foreground/5 -m-2 h-auto flex-1 justify-between gap-2 rounded-md p-2 text-sm font-medium transition-colors duration-200"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{getCleanRepoName(repository.repo_name)}</span>
                {/* Status indicators when repo section is collapsed */}
                {isCollapsed &&
                  (() => {
                    const unreadCount = getRepoUnreadCount(repository.workspaces);
                    const statusCounts = getStatusCounts(repository.workspaces);
                    const hasWorking = statusCounts.working > 0;
                    const hasError = statusCounts.error > 0;

                    return (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {hasError && (
                          <div
                            className="bg-destructive h-2 w-2 rounded-full"
                            title={`${statusCounts.error} error${
                              statusCounts.error === 1 ? "" : "s"
                            }`}
                          />
                        )}
                        {unreadCount > 0 && (
                          <div
                            className="bg-status-unread h-2 w-2 rounded-full"
                            title={`${unreadCount} unread`}
                          />
                        )}
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
      </SidebarMenuItem>
      <CollapsibleContent>
        <SidebarMenuSub className="mx-0 gap-0 border-l-0 px-0 py-0">
          {sidebarExpanded &&
            (() => {
              const sortedWorkspaces = sortByStatusPriority(repository.workspaces);
              const groupedWorkspaces = groupByStatus(sortedWorkspaces);

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
                        <div className="flex items-center px-2 py-2">
                          <span
                            className={cn("text-2xs font-mono tracking-wider", sectionConfig.text)}
                          >
                            {label}
                          </span>
                        </div>

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
