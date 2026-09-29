import { useState, type KeyboardEvent } from "react";
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
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { ModelPicker, CloudToggle, BranchPickerButton } from "./composer/ComposerControls";
import { getStoredModel, setStoredModel } from "@/features/session/lib/modelPreference";
import { getDefaultModelForHarness, getModelOption } from "@/shared/agents";

interface NewWorkspacePromptModalProps {
  show: boolean;
  repos: Repository[];
  selectedRepoId: string;
  creating: boolean;
  kind?: "workspace" | "project";
  error?: string;
  onClose: () => void;
  onRepoChange: (repoId: string) => void;
  /** Starter prompt (Create with AI) — consumed at mount; remount via key to reset. */
  initialPrompt?: string;
  /** Both kinds permit an empty prompt; a brief-less Project opens with the coordinator asking for one. */
  onSubmit: (params: {
    repoId: string;
    prompt: string;
    branch?: string;
    location: "local" | "cloud";
    model: string;
    /** Project name; empty means derive it from the prompt or the repository. */
    title?: string;
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
  kind = "workspace",
  error,
  onClose,
  onRepoChange,
  onSubmit,
  initialPrompt,
}: NewWorkspacePromptModalProps) {
  const isProject = kind === "project";
  const isMobile = useIsMobile();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState<"local" | "cloud">("local");
  const [model, setModel] = useState(() => {
    const stored = getStoredModel();
    return isProject && getModelOption(stored)?.agentHarness !== "claude-code"
      ? getDefaultModelForHarness("claude-code")
      : stored;
  });
  const [branchSelection, setBranchSelection] = useState<{
    repoId: string;
    branch: string;
  } | null>(null);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  const displayBranch = selectedBranch ?? selectedRepo?.git_default_branch ?? "main";
  const canSubmit = Boolean(selectedRepo) && !creating;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      repoId: selectedRepoId,
      prompt: prompt.trim(),
      branch: selectedBranch ?? undefined,
      location: isProject ? "local" : location,
      model,
      ...(isProject && { title: title.trim() }),
    });
    if (!isProject) {
      setPrompt("");
      setLocation("local");
      setBranchSelection(null);
    }
  };

  const submitOnEnter = (e: KeyboardEvent<HTMLElement>) => {
    if (
      e.key === "Enter" &&
      !isMobile &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={show} onOpenChange={(open) => !open && (!isProject || !creating) && onClose()}>
      <DialogContent className="gap-0 p-3 sm:max-w-[560px]" showCloseButton={false}>
        <DialogTitle className="sr-only">{isProject ? "New project" : "New Workspace"}</DialogTitle>

        {/* Context row — repo + branch left, cloud toggle right */}
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className="flex min-w-0 items-center">
            <Select
              value={selectedRepoId}
              onValueChange={onRepoChange}
              disabled={isProject && creating}
            >
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

            {selectedRepoId && !isProject && (
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

          {!isProject && (
            <CloudToggle
              location={location}
              onLocationChange={setLocation}
              repoId={selectedRepoId || null}
            />
          )}
        </div>

        {/* Typing card — textarea + bottom toolbar, welcome-composer anatomy */}
        <div className="bg-bg-elevated rounded-xl transition-shadow duration-200 focus-within:shadow-sm">
          {isProject && (
            <input
              value={title}
              maxLength={160}
              disabled={creating}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={submitOnEnter}
              placeholder={selectedRepo?.name ?? "Project name"}
              aria-label="Project name"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="text-text-primary placeholder:text-text-disabled w-full bg-transparent px-4 pt-3 text-sm font-medium outline-none"
            />
          )}
          <textarea
            value={prompt}
            maxLength={isProject ? 20000 : undefined}
            disabled={isProject && creating}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={submitOnEnter}
            placeholder={
              isProject
                ? "What should this project accomplish? Optional — the coordinator will ask."
                : "Describe what you'd like to do..."
            }
            aria-label={
              isProject
                ? "What should this project accomplish?"
                : "Message to start the new workspace"
            }
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={3}
            autoFocus={!isProject}
            className={cn(
              "text-text-primary placeholder:text-text-disabled w-full resize-none bg-transparent",
              "max-h-48 overflow-y-auto px-4 pb-1 text-sm leading-relaxed outline-none",
              isProject ? "min-h-[64px] pt-1.5" : "min-h-[76px] pt-3"
            )}
          />

          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-2">
            <ModelPicker
              model={model}
              agentHarness={isProject ? "claude-code" : undefined}
              disabled={isProject && creating}
              onModelChange={(value) => {
                setModel(value);
                if (!isProject) setStoredModel(value);
              }}
            />

            {/* Send / create button */}
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              aria-label={
                isProject
                  ? "Start project"
                  : prompt.trim()
                    ? "Create workspace and send"
                    : "Create workspace"
              }
              title={
                isProject
                  ? "Start project (Enter)"
                  : prompt.trim()
                    ? "Create & send (Enter)"
                    : "Create workspace (Enter)"
              }
              className={cn(
                "control-interaction mr-1 flex h-7 w-7 items-center justify-center rounded-full",
                canSubmit
                  ? "bg-button-primary text-button-primary-foreground hover:opacity-90"
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
        {error && (
          <p role="alert" className="text-destructive px-2 pt-3 text-xs">
            {error}
          </p>
        )}
        {isProject && repos.length === 0 && (
          <p className="text-text-tertiary px-2 pt-3 text-xs">
            Add a local repository from the sidebar to start a project.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
