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
      <DialogContent className="max-h-[90vh] sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Edit System Prompt - {workspaceName}</DialogTitle>
          <DialogDescription>
            Edit the CLAUDE.md file to customize Claude's behavior for this workspace. This prompt
            is sent with every message.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {loading ? (
            <div className="text-muted-foreground flex h-[400px] items-center justify-center">
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
              className="min-h-[400px] resize-y font-mono text-sm"
            />
          )}

          <p className="text-muted-foreground text-sm">
            💡 Tip: Use Markdown formatting. Changes are saved to{" "}
            <code className="bg-muted rounded-md px-1 py-0.5 text-xs">CLAUDE.md</code> in the workspace
            directory.
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
