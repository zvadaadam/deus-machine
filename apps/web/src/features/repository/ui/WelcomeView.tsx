import { useState, useCallback, useRef, useMemo, useEffect, createElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, ChevronDown, Check, FolderOpen, GitBranch, Search, Upload } from "lucide-react";
import { capabilities } from "@/platform/capabilities";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import {
  getRuntimeModelLabel,
  getRuntimeModelOption,
  RUNTIME_MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  type RuntimeAgentType,
} from "@/features/session/lib/agentRuntime";
import { useImageAttachments } from "@/features/session/hooks/useImageAttachments";
import { PastedImageCard } from "@/features/session/ui/PastedImageCard";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";
import type { Repository } from "../types";

// ── Easing ──────────────────────────────────────────────────────────
const EASE_OUT_QUART: [number, number, number, number] = [0.165, 0.84, 0.44, 1];

// ── Persistence ─────────────────────────────────────────────────────
const LAST_REPO_KEY = "deus:welcome-last-repo";
const LAST_MODEL_KEY = "deus:welcome-last-model";

function getStoredRepoId(): string | null {
  try {
    return localStorage.getItem(LAST_REPO_KEY);
  } catch {
    return null;
  }
}

function setStoredRepoId(id: string) {
  try {
    localStorage.setItem(LAST_REPO_KEY, id);
  } catch {
    /* localStorage unavailable */
  }
}

function getStoredModel(): string {
  try {
    return localStorage.getItem(LAST_MODEL_KEY) ?? "claude:sonnet";
  } catch {
    return "claude:sonnet";
  }
}

function setStoredModel(model: string) {
  try {
    localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    /* localStorage unavailable */
  }
}

// ── Quick Prompts ───────────────────────────────────────────────────
const QUICK_PROMPTS = [
  "Find and fix bugs",
  "Write missing tests",
  "Explain this codebase",
  "Clean up the code",
  "Update dependencies",
];

// ── Types ───────────────────────────────────────────────────────────
interface WelcomeViewProps {
  repos: Repository[];
  onSendMessage: (repoId: string, message: string, model: string, branch?: string) => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  /** True while workspace is being created after send */
  sending?: boolean;
}

// ── Agent Logo Helper ───────────────────────────────────────────────
// Render agent logo by type. Uses createElement to avoid React Compiler's
// static-components rule (dynamic <Logo /> references are flagged).
function AgentLogo({ type, className }: { type: RuntimeAgentType; className?: string }) {
  const Logo = getAgentLogo(type);
  if (!Logo) {
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", className)} />;
  }
  return createElement(Logo, { className: cn("flex-shrink-0", className) });
}

// ── Path Utility ────────────────────────────────────────────────────
function abbreviatePath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  if (home) return path.replace(home, "~");
  return path;
}

/**
 * WelcomeView — "Gravity Well" input-first workspace launcher.
 *
 * Design direction: The message input is the gravitational center.
 * Repo picker and model selector live in a context bar at the top
 * of the input card. Quick prompts orbit below. The question headline
 * draws the eye downward into the input.
 *
 * Flow: user types message + picks repo/model -> onSendMessage()
 * -> parent creates workspace + session, transitions to two-panel layout.
 */
export function WelcomeView({
  repos = [],
  onSendMessage,
  onOpenProject,
  onCloneRepository,
  sending = false,
}: WelcomeViewProps) {
  const hasRepos = repos.length > 0;

  // ── Input state ─────────────────────────────────────────────────
  const [message, setMessage] = useState("");
  const [model, setModel] = useState(getStoredModel);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Image attachments (shared hook with MessageInput)
  const {
    attachments,
    processFiles,
    removeAttachment,
    clearAttachments,
    extractImagesFromClipboard,
    buildImageBlocks,
  } = useImageAttachments();

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const imageFiles = extractImagesFromClipboard(e);
      if (imageFiles.length > 0) {
        e.preventDefault();
        processFiles(imageFiles);
      }
    },
    [extractImagesFromClipboard, processFiles]
  );

  // Build content with images in Anthropic content blocks format
  const buildCombinedContent = useCallback(() => {
    const typed = message.trim();
    const imageBlocks = buildImageBlocks();
    if (!imageBlocks) return typed;

    const blocks: Array<Record<string, unknown>> = [];
    if (typed) {
      blocks.push({ type: "text", text: typed });
    }
    blocks.push(...imageBlocks);
    return JSON.stringify(blocks);
  }, [message, buildImageBlocks]);

  // ── Repo selection ──────────────────────────────────────────────
  // User-chosen repo ID — null means "use derived default"
  const [userRepoId, setUserRepoId] = useState<string | null>(() => {
    const stored = getStoredRepoId();
    if (stored && repos.some((r) => r.id === stored)) return stored;
    return null;
  });

  // Derive effective repo: user pick > stored > first repo
  const selectedRepoId = useMemo(() => {
    if (!hasRepos) return null;
    if (userRepoId && repos.some((r) => r.id === userRepoId)) return userRepoId;
    const stored = getStoredRepoId();
    if (stored && repos.some((r) => r.id === stored)) return stored;
    return repos[0]?.id ?? null;
  }, [hasRepos, userRepoId, repos]);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selectedRepoId) ?? null,
    [repos, selectedRepoId]
  );

  // ── Branch selection ──────────────────────────────────────────────
  // Tracks the repo the branch was chosen for — resets when repo changes
  const [branchSelection, setBranchSelection] = useState<{ repoId: string; branch: string } | null>(
    null
  );
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  const displayBranch = selectedBranch ?? selectedRepo?.git_default_branch ?? "main";

  // ── Repo picker dropdown ────────────────────────────────────────
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const repoPickerRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const filteredRepos = useMemo(() => {
    if (!repoFilter) return repos;
    const q = repoFilter.toLowerCase();
    return repos.filter((r) => r.name.toLowerCase().includes(q));
  }, [repos, repoFilter]);

  // Close on outside click
  const closeRepoPicker = useCallback(() => {
    setRepoPickerOpen(false);
    setRepoFilter("");
  }, []);

  useEffect(() => {
    if (!repoPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target as Node)) {
        closeRepoPicker();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [repoPickerOpen, closeRepoPicker]);

  const handleSelectRepo = useCallback((repoId: string) => {
    setUserRepoId(repoId);
    setStoredRepoId(repoId);
    setRepoPickerOpen(false);
    setRepoFilter("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // ── Model picker dropdown ───────────────────────────────────────
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelPickerOpen]);

  const modelLabel = getRuntimeModelLabel(model);
  const selectedModelOption = getRuntimeModelOption(model);

  const handleSelectModel = useCallback((value: string) => {
    setModel(value);
    setStoredModel(value);
    setModelPickerOpen(false);
  }, []);

  // ── Send ────────────────────────────────────────────────────────
  const hasContent = message.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !!selectedRepoId && !sending;

  const handleSend = useCallback(() => {
    if (!canSend || !selectedRepoId) return;
    const content = buildCombinedContent();
    if (!content) return;
    onSendMessage(selectedRepoId, content, model, selectedBranch ?? undefined);
    clearAttachments();
  }, [
    canSend,
    selectedRepoId,
    buildCombinedContent,
    model,
    selectedBranch,
    onSendMessage,
    clearAttachments,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Quick prompts fill the textarea — user can review/edit before sending.
  // This avoids accidental sends and lets users customize the prompt.
  const handleQuickPrompt = useCallback(
    (prompt: string) => {
      if (!selectedRepoId || sending) return;
      setMessage(prompt);
      // Focus + move cursor to end so user can append or edit
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.style.height = "auto";
          ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`;
        }
      }, 10);
    },
    [selectedRepoId, sending]
  );

  // Auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`;
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center">
      {/* Top spacer — pushes content to ~30% from top (natural reading zone,
       * not geometric center which feels lifeless on tall displays) */}
      <div className="flex-[0_0_30%]" />

      {/* Label — classifies the space without competing with the input.
       * 14px uppercase with wide tracking (Vignelli-style section label).
       * The user's typed text at 14px becomes the most prominent element.
       * Switches from "building" to "start with a project" for zero-repo. */}
      <motion.h1
        key={hasRepos ? "has-repos" : "zero-repos"}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT_QUART }}
        className="text-text-muted mb-5 w-full max-w-[560px] px-6 text-sm font-semibold uppercase"
        style={{ letterSpacing: "0.08em" }}
      >
        {hasRepos ? "What are we building?" : "Start with a project"}
      </motion.h1>

      {/* Input Card — the gravitational center */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.06, ease: EASE_OUT_QUART }}
        className="w-full max-w-[560px] px-6"
      >
        <div
          className={cn(
            "bg-bg-elevated border-border-subtle relative overflow-visible rounded-2xl border transition-[border-color,box-shadow] duration-200",
            "focus-within:border-border-strong focus-within:shadow-md",
            isDragging && "border-primary/50 ring-primary/20 ring-1"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isDragging) setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Only dismiss when cursor truly leaves the card bounds
            const rect = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < rect.left ||
              e.clientX >= rect.right ||
              e.clientY < rect.top ||
              e.clientY >= rect.bottom
            ) {
              setIsDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) processFiles(files);
          }}
        >
          {/* Drop overlay */}
          {isDragging && (
            <div className="absolute inset-0 z-50 flex items-center justify-center gap-2 rounded-2xl bg-black/30 backdrop-blur-[2px]">
              <Upload className="h-4 w-4 text-white/70" />
              <p className="text-sm font-medium text-white/70">Drop images here</p>
            </div>
          )}
          {/* Context bar — repo picker (left) + branch picker (right) */}
          <div className="border-border-subtle/50 flex items-center justify-between border-b px-1 py-0.5">
            {/* Repo picker trigger */}
            {hasRepos ? (
              <div ref={repoPickerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setRepoPickerOpen(!repoPickerOpen)}
                  className="text-text-muted hover:text-text-secondary group flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-150"
                >
                  {/* Green glow dot — active project indicator */}
                  <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
                    <span className="bg-accent-green/30 absolute -inset-0.5 rounded-full blur-[2px]" />
                    <span className="bg-accent-green relative h-1.5 w-1.5 rounded-full" />
                  </span>
                  <span className="max-w-[200px] truncate font-medium">
                    {selectedRepo?.name ?? "Select repo"}
                  </span>
                  <ChevronDown
                    className={cn(
                      "text-text-disabled size-3 transition-transform duration-200",
                      repoPickerOpen && "rotate-180"
                    )}
                  />
                </button>

                {/* Repo dropdown — opens downward from context bar */}
                <AnimatePresence>
                  {repoPickerOpen && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96, y: -4 }}
                      transition={{ duration: 0.15, ease: [0.215, 0.61, 0.355, 1] }}
                      className={cn(
                        "absolute top-full left-0 z-50 mt-1 w-72 overflow-hidden rounded-xl border",
                        "border-border/55 from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                        "shadow-[var(--shadow-elevated)]"
                      )}
                    >
                      {/* Filter input */}
                      <div className="border-border-subtle flex items-center gap-2 border-b px-3 py-2">
                        <Search className="text-text-disabled size-3.5 shrink-0" />
                        <input
                          ref={filterInputRef}
                          type="text"
                          value={repoFilter}
                          onChange={(e) => setRepoFilter(e.target.value)}
                          placeholder="Search repos..."
                          className="text-text-primary placeholder:text-text-disabled w-full bg-transparent text-xs outline-none"
                        />
                      </div>

                      {/* Repo list */}
                      <div className="scrollbar-vibrancy max-h-[224px] overflow-y-auto py-1">
                        {filteredRepos.length === 0 && (
                          <div className="text-text-disabled px-3 py-3 text-center text-xs">
                            No repos match
                          </div>
                        )}
                        {filteredRepos.map((repo) => {
                          const isSelected = repo.id === selectedRepoId;
                          return (
                            <button
                              key={repo.id}
                              type="button"
                              onClick={() => handleSelectRepo(repo.id)}
                              className={cn(
                                "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors duration-100",
                                "hover:bg-bg-raised/45",
                                isSelected ? "text-text-primary" : "text-text-secondary"
                              )}
                            >
                              <div className="flex items-center gap-2 overflow-hidden">
                                {isSelected ? (
                                  <span className="relative flex h-1 w-1 shrink-0" aria-hidden>
                                    <span className="bg-accent-green/25 absolute -inset-px rounded-full blur-[1.5px]" />
                                    <span className="bg-accent-green relative h-1 w-1 rounded-full" />
                                  </span>
                                ) : (
                                  <span className="h-1.5 w-1.5 shrink-0" />
                                )}
                                <span className="truncate font-medium">{repo.name}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-text-disabled text-2xs max-w-[120px] truncate">
                                  {abbreviatePath(repo.root_path)}
                                </span>
                                {isSelected && (
                                  <Check className="text-text-primary size-3 shrink-0" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Add repo actions */}
                      <div className="border-border-subtle border-t py-1">
                        {capabilities.nativeFolderPicker && onOpenProject && (
                          <button
                            type="button"
                            onClick={() => {
                              closeRepoPicker();
                              onOpenProject();
                            }}
                            className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-100"
                          >
                            <FolderOpen className="size-3 shrink-0" />
                            <span>Open local...</span>
                          </button>
                        )}
                        {onCloneRepository && (
                          <button
                            type="button"
                            onClick={() => {
                              closeRepoPicker();
                              onCloneRepository();
                            }}
                            className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-100"
                          >
                            <GitBranch className="size-3 shrink-0" />
                            <span>Clone from GitHub</span>
                          </button>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              /* Zero repos — "Add a project" label */
              <span className="text-text-muted flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                <FolderOpen className="size-3" />
                <span className="font-medium">Add a project</span>
              </span>
            )}

            {/* Branch picker (right side) — only when repos exist */}
            {hasRepos && (
              <BranchSelector
                repoId={selectedRepoId}
                currentBranch={displayBranch}
                onBranchSelect={(name) => {
                  if (name === selectedRepo?.git_default_branch) {
                    setBranchSelection(null);
                  } else if (selectedRepoId) {
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

          {/* Image previews — shown above textarea when images are pasted/dropped */}
          <AnimatePresence>
            {attachments.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT_QUART }}
                className="flex gap-2 overflow-x-auto px-3 pt-3"
              >
                <AnimatePresence mode="popLayout">
                  {attachments.map((attachment) => (
                    <PastedImageCard
                      key={attachment.id}
                      preview={attachment.preview}
                      fileName={attachment.file.name}
                      onRemove={() => removeAttachment(attachment.id)}
                      size="sm"
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Textarea — the hero input */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              hasRepos ? "Describe what you'd like to do..." : "Add a project to get started"
            }
            disabled={!hasRepos || sending}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={3}
            className={cn(
              "text-text-primary placeholder:text-text-disabled w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none",
              "scrollbar-vibrancy max-h-48 min-h-[76px] overflow-y-auto",
              !hasRepos && "pointer-events-none opacity-40"
            )}
          />

          {/* Bottom toolbar — model picker (left) + send button (right) */}
          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-2">
            {/* Model picker */}
            <div ref={modelPickerRef} className="relative">
              <button
                type="button"
                onClick={() => setModelPickerOpen(!modelPickerOpen)}
                className="text-text-muted hover:text-text-secondary flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150"
              >
                <AgentLogo type={selectedModelOption?.agentType ?? "claude"} className="h-3 w-3" />
                <span className="font-medium">{modelLabel}</span>
                <ChevronDown
                  className={cn(
                    "text-text-disabled size-3 transition-transform duration-200",
                    modelPickerOpen && "rotate-180"
                  )}
                />
              </button>

              {/* Model dropdown — opens downward from bottom bar */}
              <AnimatePresence>
                {modelPickerOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: -4 }}
                    transition={{ duration: 0.15, ease: [0.215, 0.61, 0.355, 1] }}
                    className={cn(
                      "absolute top-full left-0 z-50 mt-1 w-56 overflow-hidden rounded-xl border p-1.5",
                      "border-border/55 from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                      "shadow-[var(--shadow-elevated)]"
                    )}
                  >
                    {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => (
                      <div key={agentConfig.id}>
                        {groupIdx > 0 && <div className="bg-border/70 mx-1 my-1.5 h-px" />}
                        <div className="text-text-muted/90 text-2xs px-2 py-1 font-normal tracking-wide">
                          {agentConfig.groupLabel}
                        </div>
                        {RUNTIME_MODEL_OPTIONS.filter((o) => o.group === agentConfig.id).map(
                          (option) => {
                            const isSelected = selectedModelOption?.value === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => handleSelectModel(option.value)}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors duration-100",
                                  "hover:bg-bg-raised/45",
                                  isSelected ? "text-text-primary" : "text-text-secondary"
                                )}
                              >
                                <AgentLogo type={option.agentType} className="h-3.5 w-3.5" />
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
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Send button */}
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              title="Send message (Enter)"
              className={cn(
                "mr-1 flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150",
                canSend
                  ? "bg-foreground text-background hover:opacity-90 active:scale-95"
                  : "bg-bg-muted text-text-disabled cursor-default"
              )}
            >
              {sending ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </motion.div>

      {/* Quick Prompts — chip row below input card (only when repos exist) */}
      <AnimatePresence>
        {hasRepos && !message.trim() && (
          <motion.div
            key="quick-prompts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, delay: 0.12, ease: EASE_OUT_QUART }}
            className="mt-3 flex w-full max-w-[560px] flex-wrap gap-2 px-6"
          >
            {QUICK_PROMPTS.map((prompt, i) => (
              <motion.button
                key={prompt}
                type="button"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: 0.14 + i * 0.04, ease: EASE_OUT_QUART }}
                onClick={() => handleQuickPrompt(prompt)}
                disabled={!selectedRepoId || sending}
                className={cn(
                  "border-border-subtle/60 text-text-muted rounded-lg border px-3 py-2 text-xs transition-colors duration-150",
                  "hover:border-border hover:bg-foreground/[0.03] hover:text-text-secondary",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                {prompt}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Zero-repo state — project action cards replace quick prompts */}
      <AnimatePresence>
        {!hasRepos && (
          <motion.div
            key="zero-state"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.3, delay: 0.15, ease: EASE_OUT_QUART }}
            className="mt-6 w-full max-w-[560px] px-6"
          >
            <p className="text-text-muted mb-4 text-sm">
              Add a project to start working with your AI coding agent.
            </p>

            <div className="border-border-subtle bg-bg-elevated/60 overflow-hidden rounded-xl border">
              {capabilities.nativeFolderPicker && onOpenProject && (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="hover:bg-bg-raised/40 flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors duration-150"
                >
                  <div className="bg-bg-muted mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <FolderOpen className="text-text-tertiary h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-text-primary text-sm font-medium">Open a local project</h3>
                    <p className="text-text-muted mt-0.5 text-xs">
                      Browse your filesystem for an existing codebase
                    </p>
                  </div>
                </button>
              )}

              {capabilities.nativeFolderPicker && onOpenProject && onCloneRepository && (
                <div className="border-border-subtle/50 mx-4 border-t" />
              )}

              {onCloneRepository && (
                <button
                  type="button"
                  onClick={onCloneRepository}
                  className="hover:bg-bg-raised/40 flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors duration-150"
                >
                  <div className="bg-bg-muted mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <GitBranch className="text-text-tertiary h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-text-primary text-sm font-medium">Clone from GitHub</h3>
                    <p className="text-text-muted mt-0.5 text-xs">
                      Paste a repository URL or search your GitHub repos
                    </p>
                  </div>
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer actions — subtle secondary entry points (only when repos exist) */}
      <AnimatePresence>
        {hasRepos && (
          <motion.div
            key="footer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, delay: 0.25, ease: EASE_OUT_QUART }}
            className="pb-8"
          >
            <div className="flex items-center gap-3">
              {capabilities.nativeFolderPicker && onOpenProject && (
                <>
                  <button
                    type="button"
                    onClick={onOpenProject}
                    className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors duration-150 hover:underline"
                  >
                    Open local project
                  </button>
                  {onCloneRepository && (
                    <span className="bg-foreground/10 inline-block h-1 w-1 rounded-full" />
                  )}
                </>
              )}
              {onCloneRepository && (
                <button
                  type="button"
                  onClick={onCloneRepository}
                  className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors duration-150 hover:underline"
                >
                  Clone from GitHub
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
