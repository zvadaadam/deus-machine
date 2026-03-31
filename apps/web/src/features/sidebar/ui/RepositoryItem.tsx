import { useMemo } from "react";
import { Plus, ChevronRight, ChevronDown, GitPullRequest } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { getCleanRepoName, splitByRecency } from "../lib/utils";
import { sortByStatusPriority } from "../lib/status";
import { useSidebarStore } from "../store/sidebarStore";
import type { RepositoryItemProps } from "../model/types";
import type { Workspace, DiffStats, RepoGroup } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import { WorkspaceItem } from "./WorkspaceItem";

import { SidebarRow, SidebarRowMain, SidebarRowIconSlot, SidebarRowRight } from "./SidebarRow";
import { DeusRepositoryBanner } from "./DeusRepositoryBanner";

/** Check if a git remote URL points to GitHub */
function isGitHubUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("github.com");
}

/**
 * RepositoryItem — collapsible repo section header.
 *
 * Layout:
 *   [REPO NAME] [count → chevron on hover]  ...  [PR] [+]  (hover-reveal actions)
 *     └── WorkspaceItem[]
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

  // Build set of workspace IDs that have any unread tab session,
  // checking all tab sessions (matching WorkspaceItem's logic).
  const unreadMap = useUnreadStore((s) => s.unreadSessionIds);
  const layouts = useWorkspaceLayoutStore((s) => s.layouts);
  const unreadWorkspaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of repository.workspaces) {
      const tabIds = layouts[ws.id]?.chatTabSessionIds;
      const sessionIds = tabIds?.length
        ? tabIds
        : ws.current_session_id
          ? [ws.current_session_id]
          : [];
      if (sessionIds.some((sid) => unreadMap[sid])) ids.add(ws.id);
    }
    return ids.size > 0 ? ids : undefined;
  }, [repository.workspaces, unreadMap, layouts]);
  // Detect the deus repo by clean name
  const isDeus = repoName === "deus";
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
            <SidebarRowMain className="gap-1.5">
              <span className="text-text-muted truncate text-xs font-medium tracking-tighter uppercase">
                {repoName}
              </span>
              <div className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                {workspaceCount > 0 && (
                  <span className="text-text-disabled text-xs tabular-nums transition-opacity duration-150 group-focus-within/repository-item:opacity-0 group-hover/repository-item:opacity-0">
                    {workspaceCount}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    "absolute inset-0 m-auto h-3.5 w-3.5",
                    "text-text-muted opacity-0 transition-[transform,opacity] duration-150 group-focus-within/repository-item:opacity-100 group-hover/repository-item:opacity-100",
                    !isCollapsed && "rotate-90"
                  )}
                />
              </div>
            </SidebarRowMain>
            {sidebarExpanded && (
              <SidebarRowRight className="gap-2 opacity-0 transition-opacity duration-150 group-focus-within/repository-item:opacity-100 group-hover/repository-item:opacity-100">
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
            className="flex min-w-0 flex-col overflow-hidden pt-1 pb-2"
          >
            {sidebarExpanded && (
              <RepositoryWorkspaceList
                repository={repository}
                isDeus={isDeus}
                selectedWorkspaceId={selectedWorkspaceId}
                unreadWorkspaceIds={unreadWorkspaceIds}
                diffStatsMap={diffStatsMap}
                reduceMotion={reduceMotion}
                onNewWorkspace={onNewWorkspace}
                onWorkspaceClick={onWorkspaceClick}
                onArchive={onArchive}
                onStatusChange={onStatusChange}
              />
            )}
          </m.ul>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}

// ── Inner list with stale-workspace collapsing ───────────────────────────

interface RepositoryWorkspaceListProps {
  repository: RepoGroup;
  isDeus: boolean;
  selectedWorkspaceId: string | null;
  unreadWorkspaceIds?: Set<string>;
  diffStatsMap?: Record<string, DiffStats>;
  reduceMotion: boolean | null;
  onNewWorkspace: (repoId?: string) => void;
  onWorkspaceClick: (workspace: Workspace) => void;
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
}

function RepositoryWorkspaceList({
  repository,
  isDeus,
  selectedWorkspaceId,
  unreadWorkspaceIds,
  diffStatsMap,
  reduceMotion,
  onNewWorkspace,
  onWorkspaceClick,
  onArchive,
  onStatusChange,
}: RepositoryWorkspaceListProps) {
  const isExpanded = useSidebarStore((s) => s.expandedOldWorkspaces.has(repository.repo_id));
  const toggleOldWorkspaces = useSidebarStore((s) => s.toggleOldWorkspaces);

  const sortedWorkspaces = sortByStatusPriority(
    repository.workspaces.filter((w) => w.state !== "archived"),
    unreadWorkspaceIds
  );

  const [visible, stale] = splitByRecency(sortedWorkspaces, selectedWorkspaceId);
  const hasStale = stale.length > 0;
  const displayedWorkspaces = hasStale && !isExpanded ? visible : sortedWorkspaces;

  return (
    <>
      {isDeus && (
        <m.li
          initial={reduceMotion ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.22,
            ease: [0.165, 0.84, 0.44, 1],
            delay: reduceMotion ? 0 : 0.02,
          }}
        >
          <DeusRepositoryBanner onNewWorkspace={() => onNewWorkspace(repository.repo_id)} />
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

      {displayedWorkspaces.map((workspace, index) => (
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

      {hasStale && (
        <m.li
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
        >
          <SidebarRow
            variant="action"
            asChild
            className="text-text-muted hover:text-text-secondary w-full text-left"
          >
            <button type="button" onClick={() => toggleOldWorkspaces(repository.repo_id)}>
              <SidebarRowMain>
                <SidebarRowIconSlot>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-150",
                      isExpanded && "rotate-180"
                    )}
                  />
                </SidebarRowIconSlot>
                <span className="text-xs font-medium">
                  {isExpanded ? "Show less" : `Show ${stale.length} more`}
                </span>
              </SidebarRowMain>
            </button>
          </SidebarRow>
        </m.li>
      )}
    </>
  );
}
