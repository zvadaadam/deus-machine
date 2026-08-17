import { useState } from "react";
import { Cloud, Laptop } from "lucide-react";
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
import { cn } from "@/shared/lib/utils";

interface NewWorkspaceModalProps {
  show: boolean;
  repos: Repository[];
  selectedRepoId: string;
  creating: boolean;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  onCreate: (location?: "local" | "cloud") => void;
  mode?: NewWorkspaceMode;
}

/**
 * Modal for creating a new workspace
 * User selects a repository and the system creates a git worktree with a city
 * name — or, with Cloud selected, an agnt sandbox that clones the repo's
 * origin remote.
 */
export function NewWorkspaceModal({
  show,
  repos,
  selectedRepoId,
  creating,
  onClose,
  onRepoChange,
  onCreate,
  mode = "default",
}: NewWorkspaceModalProps) {
  const isFromGitHub = mode === "from-github";
  const [location, setLocation] = useState<"local" | "cloud">("local");

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

          {!isFromGitHub && (
            <div className="grid gap-2">
              <Label>Where it runs</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    {
                      value: "local",
                      label: "Local",
                      icon: Laptop,
                      hint: "git worktree on this Mac",
                    },
                    {
                      value: "cloud",
                      label: "Cloud",
                      icon: Cloud,
                      hint: "agnt sandbox (clones origin)",
                    },
                  ] as const
                ).map(({ value, label, icon: Icon, hint }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setLocation(value)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors",
                      location === value
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                    <span className="text-muted-foreground text-xs">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => onCreate(isFromGitHub ? undefined : location)}
            disabled={creating || !selectedRepoId}
            className="gap-2"
          >
            {creating ? "⟳" : isFromGitHub ? "→" : "+"}
            {creating ? "Creating..." : isFromGitHub ? "Continue" : "Create Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
