import { WorkspaceItem } from "./WorkspaceItem";
import type { RepoGroup as RepoGroupType, Workspace, DiffStats } from "../../../types";

interface RepoGroupProps {
  group: RepoGroupType;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  diffStats: Record<string, DiffStats>;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
}

/**
 * Repository group in sidebar
 * Shows repository name with collapsible workspace list
 */
export function RepoGroup({
  group,
  isCollapsed,
  selectedWorkspaceId,
  diffStats,
  onToggleCollapse,
  onWorkspaceClick,
}: RepoGroupProps) {
  // Filter to only show ready workspaces in sidebar
  const readyWorkspaces = group.workspaces.filter((w) => w.state === 'ready');

  // Only show repos that have ready workspaces
  if (readyWorkspaces.length === 0) {
    return null;
  }

  return (
    <div className="repo-group">
      <div
        className={`repo-group-header ${isCollapsed ? 'collapsed' : ''}`}
        onClick={onToggleCollapse}
      >
        <span className="collapse-icon">▼</span>
        <span className="repo-group-title">{group.repo_name}</span>
      </div>

      {!isCollapsed &&
        readyWorkspaces.map((workspace) => (
          <WorkspaceItem
            key={workspace.id}
            workspace={workspace}
            diffStats={diffStats[workspace.id]}
            isActive={selectedWorkspaceId === workspace.id}
            onClick={() => onWorkspaceClick(workspace)}
          />
        ))}
    </div>
  );
}
