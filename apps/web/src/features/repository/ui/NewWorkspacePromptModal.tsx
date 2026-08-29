import { useState } from "react";
import { ArrowUp } from "lucide-react";
import type { Repository } from "../types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/shared/lib/utils";
import { ModelPicker, CloudToggle, BranchPickerButton } from "./composer/ComposerControls";
import { getStoredModel, setStoredModel } from "./HomeView";

interface NewWorkspacePromptModalProps {
  show: boolean;
  repos: Repository[];
  selectedRepoId: string;
  creating: boolean;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  /** Starter prompt (Create with AI) — consumed at mount; remount via key to reset. */
  initialPrompt?: string;
  /** Empty prompt = create only; non-empty = create and send it as turn one. */
  onSubmit: (params: {
    repoId: string;
    prompt: string;
    branch?: string;
    location: "local" | "cloud";
    model: string;
  }) => void;
}

/**
 * Prompt-first workspace creation — the welcome composer, in a modal shell.
 * Same anatomy as HomeView's composer: context row (repo + branch left, cloud
 * toggle right) above the typing card (textarea + model picker + round send),
 * built from the SHARED ComposerControls. Repo preselected when opened from a
 * repo row; the prompt rides as turn one.
 */
export function NewWorkspacePromptModal({
  show,
  repos,
  selectedRepoId,
  creating,
  onClose,
  onRepoChange,
  onSubmit,
  initialPrompt,
}: NewWorkspacePromptModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [location, setLocation] = useState<"local" | "cloud">("local");
  const [model, setModel] = useState(getStoredModel);
  const [branchSelection, setBranchSelection] = useState<{
    repoId: string;
    branch: string;
  } | null>(null);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  const displayBranch = selectedBranch ?? selectedRepo?.git_default_branch ?? "main";
  const canSubmit = Boolean(selectedRepoId) && !creating;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      repoId: selectedRepoId,
      prompt: prompt.trim(),
      branch: selectedBranch ?? undefined,
      location,
      model,
    });
    setPrompt("");
    setLocation("local");
    setBranchSelection(null);
  };

  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 p-3 sm:max-w-[560px]" showCloseButton={false}>
        <DialogTitle className="sr-only">New Workspace</DialogTitle>

        {/* Context row — repo + branch left, cloud toggle right */}
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className="flex min-w-0 items-center">
            <Select value={selectedRepoId} onValueChange={onRepoChange}>
              <SelectTrigger
                className={cn(
                  "text-text-secondary hover:text-text-primary h-auto w-auto max-w-[220px] gap-1.5",
                  "border-none bg-transparent px-2 py-1.5 text-xs font-medium shadow-none",
                  "transition-colors duration-150 focus-visible:ring-0 [&_svg]:size-2.5"
                )}
              >
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
              <BranchPickerButton
                repoId={selectedRepoId}
                displayBranch={displayBranch}
                onBranchSelect={(name) => {
                  if (name === selectedRepo?.git_default_branch) {
                    setBranchSelection(null);
                  } else {
                    setBranchSelection({ repoId: selectedRepoId, branch: name });
                  }
                }}
              />
            )}
          </div>

          <CloudToggle
            location={location}
            onLocationChange={setLocation}
            repoId={selectedRepoId || null}
          />
        </div>

        {/* Typing card — textarea + bottom toolbar, welcome-composer anatomy */}
        <div className="bg-bg-elevated rounded-xl transition-shadow duration-200 focus-within:shadow-sm">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Describe what you'd like to do..."
            aria-label="Message to start the new workspace"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={3}
            autoFocus
            className={cn(
              "text-text-primary placeholder:text-text-disabled w-full resize-none bg-transparent",
              "max-h-48 min-h-[76px] overflow-y-auto px-4 pt-3 pb-1 text-sm leading-relaxed outline-none"
            )}
          />

          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-2">
            <ModelPicker
              model={model}
              onModelChange={(value) => {
                setModel(value);
                setStoredModel(value);
              }}
            />

            {/* Send / create button */}
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              aria-label={prompt.trim() ? "Create workspace and send" : "Create workspace"}
              title={prompt.trim() ? "Create & send (Enter)" : "Create workspace (Enter)"}
              className={cn(
                "mr-1 flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150",
                canSubmit
                  ? "bg-foreground text-background hover:opacity-90 active:scale-95"
                  : "bg-bg-muted text-text-disabled cursor-default"
              )}
            >
              {creating ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
