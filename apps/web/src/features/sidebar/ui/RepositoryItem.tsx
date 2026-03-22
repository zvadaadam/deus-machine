import { Plus, ChevronRight, GitPullRequest } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { getCleanRepoName } from "../lib/utils";
import { sortByStatusPriority } from "../lib/status";
import type { RepositoryItemProps } from "../model/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { RepoAvatar } from "./RepoAvatar";
import { SidebarRow, SidebarRowMain, SidebarRowIconSlot, SidebarRowRight } from "./SidebarRow";
import { OpenDevsRepositoryBanner } from "./OpenDevsRepositoryBanner";

/** Check if a git remote URL points to GitHub */
function isGitHubUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("github.com");
}

/**
 * RepositoryItem — V2: Jony Ive
 *
 * Layout:
 *   [Badge 20×20] [RepoName]  ...  [PR] [+] [⋯]  (hover-reveal actions)
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
  onNewWorkspaceFromGitHub,
  onArchive,
  onStatusChange,
  diffStatsMap,
  sidebarExpanded,
}: RepositoryItemProps) {
  const reduceMotion = useReducedMotion();
  const repoName = getCleanRepoName(repository.repo_name);
  // Detect the opendevs repo by clean name (works for "opendevs" or "org/opendevs")
  const isOpenDevs = repoName === "opendevs";
  const workspaceCount = repository.workspaces.filter((w) => w.state !== "archived").length;

  return (
    <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse()}>
      <SidebarMenuItem
        data-state={isCollapsed ? "closed" : "open"}
        className="group/repository-item relative"
      >
        <CollapsibleTrigger asChild>
          <SidebarRow
            variant="repo"
            role="button"
            aria-label={`Toggle ${repoName} workspaces`}
            className="cursor-grab"
          >
            <SidebarRowMain className="gap-2">
              <div className="relative flex-shrink-0">
                <div className="transition-opacity duration-150 group-hover/repository-item:opacity-0">
                  <RepoAvatar repoName={repository.repo_name} />
                </div>
                <ChevronRight
                  className={cn(
                    "absolute inset-0 m-auto h-4 w-4",
                    "text-text-muted opacity-0 transition-[transform,opacity] duration-150 group-hover/repository-item:opacity-100",
                    !isCollapsed && "rotate-90"
                  )}
                />
              </div>
              <span className="text-text-secondary truncate text-sm font-medium">{repoName}</span>
              {workspaceCount > 0 && (
                <span className="text-text-muted text-xs tabular-nums">{workspaceCount}</span>
              )}
            </SidebarRowMain>
            {sidebarExpanded && (
              <SidebarRowRight className="gap-2 opacity-0 transition-opacity duration-150 group-hover/repository-item:opacity-100">
                {isGitHubUrl(repository.git_origin_url) && onNewWorkspaceFromGitHub && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`New workspace from PR or branch in ${repoName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorkspaceFromGitHub(repository.repo_id);
                        }}
                        className="text-text-muted hover:text-text-tertiary cursor-pointer [&_*]:cursor-pointer"
                      >
                        <GitPullRequest className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">New from PR or branch</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
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
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New workspace</TooltipContent>
                </Tooltip>
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

                    {sortedWorkspaces.length === 0 && (
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
                    )}

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
