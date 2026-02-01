import { ChevronDown, Plus } from "lucide-react";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";
import { sortByStatusPriority } from "../lib/status";
import type { RepositoryItemProps } from "../model/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { DragHandle } from "./DragHandle";
import { RepoAvatar } from "./RepoAvatar";
import { SidebarRow, SidebarRowIconSlot, SidebarRowMain, SidebarRowRight } from "./SidebarRow";

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
  const repoName = getCleanRepoName(repository.repo_name);

  return (
    <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse()}>
      <SidebarMenuItem
        data-state={isCollapsed ? "closed" : "open"}
        className="group/repository-item relative"
      >
        {dragHandleProps && <DragHandle {...dragHandleProps} />}
        <SidebarRow variant="repo">
          <SidebarRowMain className="gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={`Toggle ${repoName} workspaces`}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <RepoAvatar repoName={repository.repo_name} />
                <span className="truncate text-sm font-medium">{repoName}</span>
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center",
                    "opacity-0 transition-opacity duration-200",
                    "group-hover/repository-item:opacity-100"
                  )}
                  aria-hidden="true"
                >
                  <ChevronDown
                    className={cn(
                      "text-muted-foreground h-4 w-4 transition-transform duration-200",
                      isCollapsed && "-rotate-90"
                    )}
                  />
                </span>
              </button>
            </CollapsibleTrigger>
          </SidebarRowMain>
          {sidebarExpanded && (
            <SidebarRowRight className="gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`New workspace in ${repoName}`}
                onClick={() => onNewWorkspace(repository.repo_id)}
                className="text-muted-foreground/60 hover:text-muted-foreground h-5 w-5"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </SidebarRowRight>
          )}
        </SidebarRow>
      </SidebarMenuItem>
      <CollapsibleContent>
        <ul className="flex min-w-0 flex-col gap-1">
          {sidebarExpanded &&
            (() => {
              const sortedWorkspaces = sortByStatusPriority(
                repository.workspaces.filter((w) => w.state !== "archived")
              );

              return (
                <>
                  <li>
                    <SidebarRow
                      variant="action"
                      asChild
                      onClick={() => onNewWorkspace(repository.repo_id)}
                      className="text-muted-foreground/80 hover:text-foreground w-full text-left text-[13px]"
                    >
                      <button type="button">
                        <SidebarRowMain indent="workspace">
                          <SidebarRowIconSlot>
                            <Plus className="h-3.5 w-3.5" />
                          </SidebarRowIconSlot>
                          <span className="font-normal">New workspace</span>
                        </SidebarRowMain>
                      </button>
                    </SidebarRow>
                  </li>

                  {sortedWorkspaces.map((workspace) => (
                    <WorkspaceItem
                      key={workspace.id}
                      workspace={workspace}
                      isActive={workspace.id === selectedWorkspaceId}
                      onClick={() => onWorkspaceClick(workspace)}
                      onArchive={onArchive}
                    />
                  ))}
                </>
              );
            })()}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
