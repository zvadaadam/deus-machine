import { formatTimeAgo } from "../../../utils";
import type { Workspace, DiffStats } from "../../../types";

interface WorkspaceItemProps {
  workspace: Workspace;
  diffStats?: DiffStats;
  isActive: boolean;
  onClick: () => void;
}

/**
 * Individual workspace list item in sidebar
 * Shows branch name, diff stats, and last updated time
 */
export function WorkspaceItem({
  workspace,
  diffStats,
  isActive,
  onClick,
}: WorkspaceItemProps) {
  const hasDiff = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);
  const timeAgo = formatTimeAgo(workspace.updated_at);

  return (
    <div
      className={`workspace-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="workspace-item-icon">🌿</span>
      <div className="workspace-item-content">
        <div className="workspace-item-header">
          <span className="workspace-item-title">{workspace.branch}</span>
          {hasDiff && (
            <span className="workspace-item-diff">
              {diffStats.additions > 0 && (
                <span className="additions">+{diffStats.additions}</span>
              )}
              {diffStats.deletions > 0 && (
                <span className="deletions">-{diffStats.deletions}</span>
              )}
            </span>
          )}
        </div>
        <div className="workspace-item-meta">
          {workspace.session_status === 'working' ? (
            <span className="workspace-item-status">Working...</span>
          ) : (
            <>
              <span>{workspace.directory_name}</span>
              <span> • </span>
              <span>{timeAgo}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
