import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

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
  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Edit System Prompt - {workspaceName}</DialogTitle>
          <DialogDescription>
            Edit the CLAUDE.md file to customize Claude's behavior for this
            workspace. This prompt is sent with every message.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {loading ? (
            <div className="flex items-center justify-center h-[400px] text-muted-foreground">
              Loading system prompt...
            </div>
          ) : (
            <Textarea
              value={systemPrompt}
              onChange={(e) => onChange(e.target.value)}
              placeholder="# Instructions

## Workspace Guidelines
- Add your custom instructions here
- Define coding standards, patterns, best practices
- Specify testing requirements

## Context
- Describe the project structure
- List important files or modules
- Add any domain-specific knowledge"
              className="min-h-[400px] font-mono text-sm resize-y"
            />
          )}

          <p className="text-sm text-muted-foreground">
            💡 Tip: Use Markdown formatting. Changes are saved to{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              CLAUDE.md
            </code>{" "}
            in the workspace directory.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving} className="gap-2">
            {saving ? "⟳" : "💾"}
            {saving ? "Saving..." : "Save System Prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
