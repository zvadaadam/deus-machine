import type { Repository } from "../types";
import type { NewWorkspaceMode } from "@/shared/stores/uiStore";
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
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  onCreate: () => void;
  mode?: NewWorkspaceMode;
}

/**
 * Repo picker step for the "from GitHub PR/branch" flow — choose a repository,
 * then the GitHub picker takes over. Plain creation lives in
 * NewWorkspacePromptModal (prompt-first, with the Local/Cloud choice).
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
  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>New Workspace from{"…"}</DialogTitle>
          <DialogDescription>
            Select a repository, then choose a pull request or branch.
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onCreate} disabled={creating || !selectedRepoId} className="gap-2">
            {creating ? "⟳" : "→"}
            {creating ? "Creating..." : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
