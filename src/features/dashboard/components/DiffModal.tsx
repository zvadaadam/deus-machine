interface DiffModalProps {
  selectedFile: string | null;
  fileDiff: string;
  loading: boolean;
  onClose: () => void;
}

/**
 * Modal for displaying git diff for a specific file
 * Shows unified diff format with syntax highlighting
 */
export function DiffModal({
  selectedFile,
  fileDiff,
  loading,
  onClose,
}: DiffModalProps) {
  if (!selectedFile) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Diff: {selectedFile}</h2>
          <button onClick={onClose} className="modal-close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="loading">Loading diff...</div>
          ) : (
            <pre className="diff-content">{fileDiff}</pre>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
