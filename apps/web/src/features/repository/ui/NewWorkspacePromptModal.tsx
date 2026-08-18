import { createElement, useState } from "react";
import { ArrowUp, Check, ChevronDown, Cloud, GitBranch } from "lucide-react";
import type { Repository } from "../types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import {
  getModelLabel,
  getModelOption,
  MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  type AgentHarness,
} from "@/shared/agents";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";
import { getStoredModel, setStoredModel } from "./HomeView";

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
    model: string;
  }) => void;
}

function AgentLogo({ type, className }: { type: AgentHarness; className?: string }) {
  const Logo = getAgentLogo(type);
  if (!Logo) {
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", className)} />;
  }
  return createElement(Logo, { className: cn("flex-shrink-0", className) });
}

/**
 * Prompt-first workspace creation — the welcome composer, in a modal shell.
 * Same anatomy as HomeView's composer: context row (repo + branch left, cloud
 * toggle right) above the typing card (textarea + model picker + round send).
 * Repo preselected when opened from a repo row; the prompt rides as turn one.
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
  const [model, setModel] = useState(getStoredModel);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [branchSelection, setBranchSelection] = useState<{
    repoId: string;
    branch: string;
  } | null>(null);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  const displayBranch = selectedBranch ?? selectedRepo?.git_default_branch ?? "main";
  const selectedModelOption = getModelOption(model);
  const modelLabel = getModelLabel(model);
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
            {/* Model picker */}
            <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-text-muted hover:text-text-secondary flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150"
                >
                  <AgentLogo
                    type={selectedModelOption?.agentHarness ?? "claude-code"}
                    className="h-3 w-3"
                  />
                  <span className="font-medium">{modelLabel}</span>
                  <ChevronDown
                    className={cn(
                      "text-text-disabled size-3 transition-transform duration-200",
                      modelPickerOpen && "rotate-180"
                    )}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className={cn(
                  "w-56 overflow-hidden rounded-xl p-1.5",
                  "border-border/55 from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                  "shadow-[var(--shadow-elevated)]"
                )}
              >
                {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => (
                  <div key={agentConfig.id}>
                    {groupIdx > 0 && <div className="bg-border/70 mx-1 my-1.5 h-px" />}
                    <div className="text-text-muted/90 text-2xs px-2 py-1 font-normal tracking-wide">
                      {agentConfig.label}
                    </div>
                    {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map(
                      (option) => {
                        const isSelected = selectedModelOption?.value === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              setModel(option.value);
                              setStoredModel(option.value);
                              setModelPickerOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors duration-100",
                              "hover:bg-bg-raised/45",
                              isSelected ? "text-text-primary" : "text-text-secondary"
                            )}
                          >
                            <AgentLogo type={option.agentHarness} className="h-3.5 w-3.5" />
                            <span className="font-normal">{option.label}</span>
                            {option.isNew && (
                              <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted text-2xs rounded-xs border px-1 py-px tracking-wide uppercase">
                                New
                              </span>
                            )}
                            <span className="ml-auto">
                              {isSelected && <Check className="text-text-primary size-3" />}
                            </span>
                          </button>
                        );
                      }
                    )}
                  </div>
                ))}
              </PopoverContent>
            </Popover>

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
