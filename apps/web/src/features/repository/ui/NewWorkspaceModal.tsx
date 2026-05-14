import type { Repository } from "../types";
import type { NewWorkspaceMode } from "@/shared/stores/uiStore";
import type { WorkspaceKind } from "@shared/enums";
import { ArrowRight, Cloud, HardDrive, Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface NewWorkspaceModalProps {
  show: boolean;
  repos: Repository[];
  selectedRepoId: string;
  creating: boolean;
  workspaceKind: WorkspaceKind;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  onWorkspaceKindChange: (kind: WorkspaceKind) => void;
  onCreate: () => void;
  mode?: NewWorkspaceMode;
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
  workspaceKind,
  onClose,
  onRepoChange,
  onWorkspaceKindChange,
  onCreate,
  mode = "default",
}: NewWorkspaceModalProps) {
  const isFromGitHub = mode === "from-github";

  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isFromGitHub ? "New Workspace from\u2026" : "Create New Workspace"}
          </DialogTitle>
          <DialogDescription>
            {isFromGitHub
              ? "Select a repository, then choose a pull request or branch."
              : "A new workspace will be created with an auto-generated name (city name) and git worktree."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="repo-select">Select Repository</Label>
            <Select value={selectedRepoId} onValueChange={onRepoChange}>
              <SelectTrigger id="repo-select">
                <SelectValue placeholder="Choose a repository..." />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-sm">
              The workspace will be created in this repository
            </p>
          </div>

          <div className="grid gap-2">
            <Label className="text-sm">Run Location</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onWorkspaceKindChange("local")}
                aria-pressed={workspaceKind === "local"}
                className={`border-border-subtle hover:bg-muted/60 flex h-16 items-center gap-3 rounded-lg border px-3 text-left transition-colors ${
                  workspaceKind === "local" ? "bg-muted text-foreground" : "text-muted-foreground"
                }`}
              >
                <HardDrive className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">Local</span>
                  <span className="text-muted-foreground block truncate text-xs">Desktop</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onWorkspaceKindChange("cloud")}
                aria-pressed={workspaceKind === "cloud"}
                className={`border-border-subtle hover:bg-muted/60 flex h-16 items-center gap-3 rounded-lg border px-3 text-left transition-colors ${
                  workspaceKind === "cloud" ? "bg-muted text-foreground" : "text-muted-foreground"
                }`}
              >
                <Cloud className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">Cloud</span>
                  <span className="text-muted-foreground block truncate text-xs">Claude</span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onCreate} disabled={creating || !selectedRepoId} className="gap-2">
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : isFromGitHub ? (
              <ArrowRight className="size-4" />
            ) : (
              <Plus className="size-4" />
            )}
            {creating ? "Creating..." : isFromGitHub ? "Continue" : "Create Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
