import type { Repo } from "../../../types";

interface NewWorkspaceModalProps {
  show: boolean;
  repos: Repo[];
  selectedRepoId: string;
  creating: boolean;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  onCreate: () => void;
}

/**
 * Modal for creating a new workspace
 * User selects a repository and the system creates a git worktree with a city name
 */
export function NewWorkspaceModal({
  show,
  repos,
  selectedRepoId,
  creating,
  onClose,
  onRepoChange,
  onCreate,
}: NewWorkspaceModalProps) {
  if (!show) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Create New Workspace</h2>
          <button onClick={onClose} className="modal-close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            A new workspace will be created with an auto-generated name (city
            name) and git worktree.
          </p>

          <div className="form-group">
            <label>Select Repository</label>
            <select
              value={selectedRepoId}
              onChange={(e) => onRepoChange(e.target.value)}
              className="form-control"
              autoFocus
            >
              <option value="">Choose a repository...</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            <small>The workspace will be created in this repository</small>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onCreate}
            disabled={creating || !selectedRepoId}
            className="btn-enhanced btn-enhanced-success"
          >
            <span className="btn-enhanced-icon">{creating ? "⟳" : "+"}</span>
            {creating ? "Creating..." : "Create Workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
