import { Plus, Ellipsis, ChevronRight } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";
import { sortByStatusPriority } from "../lib/status";
import type { RepositoryItemProps } from "../model/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { RepoAvatar } from "./RepoAvatar";
import { SidebarRow, SidebarRowMain, SidebarRowIconSlot, SidebarRowRight } from "./SidebarRow";
import { OpenDevsRepositoryBanner } from "./OpenDevsRepositoryBanner";

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
  onStatusChange,
  diffStatsMap,
  sidebarExpanded,
}: RepositoryItemProps) {
  const reduceMotion = useReducedMotion();
  const repoName = getCleanRepoName(repository.repo_name);
  // Detect the opendevs repo by clean name (works for "opendevs" or "org/opendevs")
  const isOpenDevs = repoName === "opendevs";

  return (
    <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse()}>
      <SidebarMenuItem
        data-state={isCollapsed ? "closed" : "open"}
        className="group/repository-item relative"
      >
        <CollapsibleTrigger asChild>
          <SidebarRow variant="repo" role="button" aria-label={`Toggle ${repoName} workspaces`}>
            <SidebarRowMain className="gap-2">
              <RepoAvatar repoName={repository.repo_name} />
              <span className="text-text-secondary truncate text-sm font-medium">{repoName}</span>
              <ChevronRight
                className={cn(
                  "text-text-muted h-3.5 w-3.5 flex-shrink-0",
                  "opacity-0 transition-[transform,opacity] duration-200 group-hover/repository-item:opacity-100",
                  !isCollapsed && "rotate-90"
                )}
              />
            </SidebarRowMain>
            {sidebarExpanded && (
              <SidebarRowRight className="gap-2 opacity-0 transition-opacity duration-150 group-hover/repository-item:opacity-100">
                <button
                  type="button"
                  aria-label={`New workspace in ${repoName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewWorkspace(repository.repo_id);
                  }}
                  className="text-text-muted hover:text-text-tertiary cursor-pointer [&_*]:cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="More options"
                  onClick={(e) => e.stopPropagation()}
                  className="text-text-muted hover:text-text-tertiary cursor-pointer [&_*]:cursor-pointer"
                >
                  <Ellipsis className="h-4 w-4" />
                </button>
              </SidebarRowRight>
            )}
          </SidebarRow>
        </CollapsibleTrigger>
      </SidebarMenuItem>
      <AnimatePresence initial={false}>
        {!isCollapsed && (
          <m.ul
            key="workspace-list"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.165, 0.84, 0.44, 1] }}
            className="flex min-w-0 flex-col overflow-hidden"
          >
            {sidebarExpanded &&
              (() => {
                const sortedWorkspaces = sortByStatusPriority(
                  repository.workspaces.filter((w) => w.state !== "archived")
                );

                return (
                  <>
                    {/* OpenDevs repo gets a special contribution nudge banner */}
                    {isOpenDevs && (
                      <m.li
                        initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.22,
                          ease: [0.165, 0.84, 0.44, 1],
                          delay: reduceMotion ? 0 : 0.02,
                        }}
                      >
                        <OpenDevsRepositoryBanner
                          onNewWorkspace={() => onNewWorkspace(repository.repo_id)}
                        />
                      </m.li>
                    )}

                    <m.li
                      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.18,
                        ease: [0.165, 0.84, 0.44, 1],
                        delay: reduceMotion ? 0 : 0.03,
                      }}
                    >
                      <SidebarRow
                        variant="action"
                        asChild
                        onClick={() => onNewWorkspace(repository.repo_id)}
                        className="text-text-tertiary hover:text-text-secondary w-full text-left text-base"
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
                    </m.li>

                    {sortedWorkspaces.map((workspace, index) => (
                      <m.li
                        key={workspace.id}
                        initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.18,
                          ease: [0.165, 0.84, 0.44, 1],
                          delay: reduceMotion ? 0 : Math.min(0.05 + index * 0.025, 0.12),
                        }}
                      >
                        <WorkspaceItem
                          workspace={workspace}
                          isActive={workspace.id === selectedWorkspaceId}
                          diffStats={diffStatsMap?.[workspace.id]}
                          onClick={onWorkspaceClick}
                          onArchive={onArchive}
                          onStatusChange={onStatusChange}
                        />
                      </m.li>
                    ))}
                  </>
                );
              })()}
          </m.ul>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}
