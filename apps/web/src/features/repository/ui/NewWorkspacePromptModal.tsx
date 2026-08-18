import { useState } from "react";
import { ChevronDown, Cloud, GitBranch } from "lucide-react";
import type { Repository } from "../types";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";

interface NewWorkspacePromptModalProps {
  show: boolean;
  repos: Repository[];
  selectedRepoId: string;
  creating: boolean;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  /** Empty prompt = create only; non-empty = create and send it as turn one. */
  onSubmit: (params: {
    repoId: string;
    prompt: string;
    branch?: string;
    location: "local" | "cloud";
  }) => void;
}

/**
 * Prompt-first workspace creation — the Home composer, in a modal.
 * Repo/branch preconfigured (repo preselected when opened from a repo row),
 * cloud as an off-by-default toggle, and the prompt rides as the first turn.
 */
export function NewWorkspacePromptModal({
  show,
  repos,
  selectedRepoId,
  creating,
  onClose,
  onRepoChange,
  onSubmit,
}: NewWorkspacePromptModalProps) {
  const [prompt, setPrompt] = useState("");
  const [location, setLocation] = useState<"local" | "cloud">("local");
  const [branchSelection, setBranchSelection] = useState<{
    repoId: string;
    branch: string;
  } | null>(null);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  const displayBranch = selectedBranch ?? selectedRepo?.git_default_branch ?? "main";

  const submit = () => {
    if (!selectedRepoId) return;
    onSubmit({
      repoId: selectedRepoId,
      prompt: prompt.trim(),
      branch: selectedBranch ?? undefined,
      location,
    });
    setPrompt("");
    setLocation("local");
    setBranchSelection(null);
  };

  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>
            Describe what you'd like to do — the workspace is created and your prompt runs as its
            first task.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {/* Context row — repo + branch left, cloud toggle right */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Select value={selectedRepoId} onValueChange={onRepoChange}>
                <SelectTrigger className="h-8 w-auto max-w-[220px] text-xs">
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

              {selectedRepoId && (
                <BranchSelector
                  repoId={selectedRepoId}
                  currentBranch={displayBranch}
                  onBranchSelect={(name) => {
                    if (name === selectedRepo?.git_default_branch) {
                      setBranchSelection(null);
                    } else {
                      setBranchSelection({ repoId: selectedRepoId, branch: name });
                    }
                  }}
                >
                  <button
                    type="button"
                    className="text-text-disabled hover:text-text-muted flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150"
                  >
                    <GitBranch className="size-3 shrink-0" />
                    <span className="max-w-[120px] truncate">{displayBranch}</span>
                    <ChevronDown className="size-2.5" />
                  </button>
                </BranchSelector>
              )}
            </div>

            <label
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150 select-none",
                location === "cloud"
                  ? "text-text-secondary"
                  : "text-text-disabled hover:text-text-muted"
              )}
            >
              <Cloud className="size-3 shrink-0" />
              <span>Cloud</span>
              <Switch
                checked={location === "cloud"}
                onCheckedChange={(on) => setLocation(on ? "cloud" : "local")}
                className="scale-75"
                aria-label="Run in a cloud sandbox"
              />
            </label>
          </div>

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Describe what you'd like to do..."
            className="min-h-[96px] resize-none text-sm"
            autoFocus
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={creating || !selectedRepoId} className="gap-2">
            {creating ? "Creating..." : prompt.trim() ? "Create & Send" : "Create Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
