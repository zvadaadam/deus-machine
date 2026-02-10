import { Plus, Ellipsis } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";
import { WorkspaceItem } from "./WorkspaceItem";
import type { RepoGroup as RepoGroupType, Workspace, DiffStats } from "@/shared/types";

interface RepoGroupProps {
  group: RepoGroupType;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  diffStats: Record<string, DiffStats>;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace?: () => void;
}

/**
 * RepoGroup — V2: Jony Ive
 *
 * Layout:
 *   [Badge 20×20] [RepoName — text-secondary 14/500]  ...  [+] [⋯]
 *     └── WorkspaceItem[]
 *
 * Badge: first letter of repo name, bg-muted rounded-md
 * Minimal chrome. The repo header earns attention through
 * contrast, not decoration.
 */
export function RepoGroup({
  group,
  isCollapsed,
  selectedWorkspaceId,
  diffStats,
  onToggleCollapse,
  onWorkspaceClick,
  onNewWorkspace,
}: RepoGroupProps) {
  const readyWorkspaces = group.workspaces.filter((w) => w.state === "ready");

  if (readyWorkspaces.length === 0) {
    return null;
  }

  const repoInitial = group.repo_name.charAt(0).toUpperCase();

  return (
    <div className="flex w-full flex-col px-1.5 py-1">
      <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
        {/* Repo header row */}
        <div className="group/repo flex w-full items-center gap-2 rounded-md px-3 py-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2">
            {/* Repo badge */}
            <div className="bg-bg-muted flex h-5 w-5 shrink-0 items-center justify-center rounded-md">
              <span className="text-text-tertiary text-[10px] font-semibold">{repoInitial}</span>
            </div>
            <span className="text-text-secondary min-w-0 flex-1 truncate text-left text-sm font-medium">
              {group.repo_name}
            </span>
          </CollapsibleTrigger>

          {/* Action icons — show on hover */}
          <div className="flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover/repo:opacity-100">
            {onNewWorkspace && (
              <button
                type="button"
                aria-label="New workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewWorkspace();
                }}
                className="text-text-muted hover:text-text-tertiary"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              aria-label="More options"
              className="text-text-muted hover:text-text-tertiary"
            >
              <Ellipsis className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Workspace list */}
        <CollapsibleContent>
          <ul className="flex flex-col">
            {readyWorkspaces.map((workspace) => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                diffStats={diffStats[workspace.id]}
                isActive={selectedWorkspaceId === workspace.id}
                onClick={() => onWorkspaceClick(workspace)}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
