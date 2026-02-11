import { Plus, Ellipsis } from "lucide-react";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";
import { sortByStatusPriority } from "../lib/status";
import type { RepositoryItemProps } from "../model/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { DragHandle } from "./DragHandle";
import { RepoAvatar } from "./RepoAvatar";
import { SidebarRow, SidebarRowMain, SidebarRowIconSlot, SidebarRowRight } from "./SidebarRow";

/**
 * RepositoryItem — V2: Jony Ive
 *
 * Layout:
 *   [Badge 20×20] [RepoName]  ...  [+] [⋯]  (hover-reveal actions)
 *     └── [+ New workspace]
 *     └── WorkspaceItem[]
 *
 * The repo header uses text-secondary (B0B0B0) 14px medium.
 * Action icons: text-muted (#787878), appear on hover.
 */
export function RepositoryItem({
  repository,
  isCollapsed,
  selectedWorkspaceId,
  onToggleCollapse,
  onWorkspaceClick,
  onNewWorkspace,
  onArchive,
  diffStatsMap,
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
                <span className="text-text-secondary truncate text-sm font-medium">{repoName}</span>
              </button>
            </CollapsibleTrigger>
          </SidebarRowMain>
          {sidebarExpanded && (
            <SidebarRowRight className="gap-2 opacity-0 transition-opacity duration-150 group-hover/repository-item:opacity-100">
              <button
                type="button"
                aria-label={`New workspace in ${repoName}`}
                onClick={() => onNewWorkspace(repository.repo_id)}
                className="text-text-muted hover:text-text-tertiary"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="More options"
                className="text-text-muted hover:text-text-tertiary"
              >
                <Ellipsis className="h-4 w-4" />
              </button>
            </SidebarRowRight>
          )}
        </SidebarRow>
      </SidebarMenuItem>
      <CollapsibleContent>
        <ul className="flex min-w-0 flex-col">
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
                      className="text-text-tertiary hover:text-text-secondary w-full text-left text-[13px]"
                    >
                      <button type="button">
                        <SidebarRowMain>
                          <SidebarRowIconSlot>
                            <Plus className="h-4 w-4" />
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
                      diffStats={diffStatsMap?.[workspace.id]}
                      onClick={onWorkspaceClick}
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
