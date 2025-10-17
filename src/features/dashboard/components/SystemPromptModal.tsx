interface SystemPromptModalProps {
  show: boolean;
  workspaceName: string;
  systemPrompt: string;
  loading: boolean;
  saving: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Modal for editing workspace system prompt (CLAUDE.md)
 * Allows customizing Claude's behavior for specific workspace
 */
export function SystemPromptModal({
  show,
  workspaceName,
  systemPrompt,
  loading,
  saving,
  onClose,
  onChange,
  onSave,
}: SystemPromptModalProps) {
  if (!show) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Edit System Prompt - {workspaceName}</h2>
          <button onClick={onClose} className="modal-close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            Edit the CLAUDE.md file to customize Claude's behavior for this
            workspace. This prompt is sent with every message.
          </p>

          {loading ? (
            <div className="loading">Loading system prompt...</div>
          ) : (
            <textarea
              value={systemPrompt}
              onChange={(e) => onChange(e.target.value)}
              className="system-prompt-editor"
              placeholder="# Instructions

## Workspace Guidelines
- Add your custom instructions here
- Define coding standards, patterns, best practices
- Specify testing requirements

## Context
- Describe the project structure
- List important files or modules
- Add any domain-specific knowledge"
              style={{
                width: "100%",
                minHeight: "400px",
                padding: "16px",
                fontFamily: "Monaco, Courier New, monospace",
                fontSize: "13px",
                lineHeight: "1.6",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                resize: "vertical",
              }}
            />
          )}

          <div
            style={{ marginTop: "12px", fontSize: "13px", color: "#6b7280" }}
          >
            💡 Tip: Use Markdown formatting. Changes are saved to{" "}
            <code>CLAUDE.md</code> in the workspace directory.
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="btn-enhanced btn-enhanced-success"
          >
            <span className="btn-enhanced-icon">{saving ? "⟳" : "💾"}</span>
            {saving ? "Saving..." : "Save System Prompt"}
          </button>
        </div>
      </div>
    </div>
  );
}
