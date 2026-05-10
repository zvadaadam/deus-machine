import { useState, useCallback, useRef, useMemo, useEffect, createElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ChevronDown,
  Check,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Search,
  Upload,
} from "lucide-react";
import { capabilities } from "@/platform/capabilities";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import {
  DEFAULT_MODEL,
  getModelLabel,
  getModelOption,
  resolveModelSelection,
  MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  type AgentHarness,
} from "@/shared/agents";
import { useImageAttachments } from "@/features/session/hooks/useImageAttachments";
import { PastedImageCard } from "@/features/session/ui/PastedImageCard";
import { CircularPixelGrid } from "@/features/session/ui/CircularPixelGrid";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";
import { WorkflowStatusIcon } from "@/features/sidebar/ui/WorkflowStatusIcon";
import { getWorkspaceDisplayName, getWorkspaceSecondaryText } from "@/features/sidebar/lib/utils";
import { getDisplayStatus } from "@/features/sidebar/lib/status";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { formatTimeAgo } from "@/shared/lib/formatters";
import type { RepoGroup, Workspace } from "@/shared/types";
import type { Repository } from "../types";
import { EASE_OUT_QUART } from "@/shared/lib/animation";

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
  // Validate against the catalog — stale localStorage (old aliases like
  // "claude:sonnet", removed models, renamed formats) falls back to the
  // current default instead of silently sending an unknown model.
  try {
    const stored = localStorage.getItem(LAST_MODEL_KEY);
    const resolved = stored ? resolveModelSelection(stored) : undefined;
    if (resolved) return resolved;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_MODEL;
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

const RECENT_WORKSPACE_LIMIT = 14;

// ── Types ───────────────────────────────────────────────────────────
interface HomeViewProps {
  repos: Repository[];
  repoGroups?: RepoGroup[];
  selectedWorkspaceId?: string | null;
  onSendMessage: (repoId: string, message: string, model: string, branch?: string) => void;
  onWorkspaceClick?: (workspace: Workspace) => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
}

interface RecentWorkspaceItem {
  workspace: Workspace;
  activityAt: string;
}

interface RecentWorkspaceGroup {
  label: string;
  items: RecentWorkspaceItem[];
}

// ── Agent Logo Helper ───────────────────────────────────────────────
// Render agent logo by type. Uses createElement to avoid React Compiler's
// static-components rule (dynamic <Logo /> references are flagged).
function AgentLogo({ type, className }: { type: AgentHarness; className?: string }) {
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

function parseAppDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWorkspaceActivityDate(workspace: Workspace): Date {
  const latestMessageDate = parseAppDate(workspace.latest_message_sent_at);
  const workspaceDate = parseAppDate(workspace.updated_at);
  return latestMessageDate ?? workspaceDate ?? new Date(0);
}

function getDayKey(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getDayLabel(date: Date, now: Date = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function buildRecentWorkspaceGroups(repoGroups: RepoGroup[]): RecentWorkspaceGroup[] {
  const recentItems = repoGroups
    .flatMap((group) =>
      group.workspaces
        .filter((workspace) => workspace.state !== "archived")
        .map((workspace) => {
          const activityDate = getWorkspaceActivityDate(workspace);
          return {
            workspace,
            activityAt: activityDate.toISOString(),
            activityMs: activityDate.getTime(),
          };
        })
    )
    .sort((a, b) => b.activityMs - a.activityMs)
    .slice(0, RECENT_WORKSPACE_LIMIT);

  const groups: RecentWorkspaceGroup[] = [];
  const indexByDay = new Map<string, RecentWorkspaceGroup>();

  for (const item of recentItems) {
    const date = new Date(item.activityAt);
    const dayKey = getDayKey(date);
    let group = indexByDay.get(dayKey);
    if (!group) {
      group = { label: getDayLabel(date), items: [] };
      indexByDay.set(dayKey, group);
      groups.push(group);
    }
    group.items.push({ workspace: item.workspace, activityAt: item.activityAt });
  }

  return groups;
}

function RecentWorkspaceStatusIcon({ workspace }: { workspace: Workspace }) {
  if (workspace.state === "initializing") {
    return <CircularPixelGrid variant="working" size={14} resolution={8} />;
  }

  const displayStatus = getDisplayStatus(workspace);

  if (displayStatus === "working") {
    return <CircularPixelGrid variant="working" size={14} resolution={8} />;
  }

  if (displayStatus === "error") {
    return <span className="bg-accent-red h-2 w-2 rounded-full" />;
  }

  if (displayStatus === "unread") {
    return <span className="bg-accent-gold h-2 w-2 rounded-full" />;
  }

  return <WorkflowStatusIcon status={workspace.status} size={14} />;
}

function getRecentWorkspaceMeta(workspace: Workspace): string {
  const secondary = getWorkspaceSecondaryText(workspace);
  const repoName = workspace.repo_name;
  if (secondary && repoName) return `${secondary} · ${repoName}`;
  return secondary ?? repoName ?? workspace.git_branch ?? "Workspace";
}

function RecentWorkspaces({
  groups,
  selectedWorkspaceId,
  onWorkspaceClick,
}: {
  groups: RecentWorkspaceGroup[];
  selectedWorkspaceId?: string | null;
  onWorkspaceClick?: (workspace: Workspace) => void;
}) {
  if (!groups.length || !onWorkspaceClick) return null;

  return (
    <motion.div
      key="recent-workspaces"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.24, delay: 0.1, ease: EASE_OUT_QUART }}
      className="mt-5 w-full max-w-[720px] px-4 sm:px-6"
    >
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group.label} aria-label={`${group.label} workspaces`}>
            <h2 className="text-text-muted mb-2 px-1 text-xs font-medium">{group.label}</h2>
            <div className="flex flex-col gap-0.5">
              {group.items.map(({ workspace, activityAt }) => {
                const isActive = workspace.id === selectedWorkspaceId;
                const displayName = getWorkspaceDisplayName(workspace);
                const meta = getRecentWorkspaceMeta(workspace);

                return (
                  <button
                    key={workspace.id}
                    type="button"
                    onClick={() => onWorkspaceClick(workspace)}
                    className={cn(
                      "group/recent-workspace flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-150",
                      "hover:bg-bg-raised/60 focus-visible:ring-primary/35 focus:outline-none focus-visible:ring-2",
                      isActive && "bg-bg-raised/70"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded",
                        isActive ? "text-text-primary" : "text-text-muted"
                      )}
                      aria-hidden
                    >
                      <RecentWorkspaceStatusIcon workspace={workspace} />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          isActive ? "text-text-primary" : "text-text-secondary"
                        )}
                      >
                        {displayName}
                      </span>
                      <span className="text-text-disabled truncate text-xs">{meta}</span>
                    </span>

                    <span className="text-text-muted shrink-0 text-xs tabular-nums">
                      {formatTimeAgo(activityAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </motion.div>
  );
}

/**
 * HomeView — "Gravity Well" input-first workspace launcher.
 *
 * Design direction: The message input is the gravitational center.
 * Repo picker and model selector live in a context bar at the top
 * of the input card. Quick prompts orbit below. The question headline
 * draws the eye downward into the input.
 *
 * Flow: user types message + picks repo/model -> onSendMessage()
 * -> parent creates workspace + session, transitions to two-panel layout.
 */
export function HomeView({
  repos = [],
  repoGroups = [],
  selectedWorkspaceId = null,
  onSendMessage,
  onWorkspaceClick,
  onOpenProject,
  onCloneRepository,
  onStartNewProject,
}: HomeViewProps) {
  const hasRepos = repos.length > 0;
  const isMobile = useIsMobile();

  // ── Input state ─────────────────────────────────────────────────
  const [message, setMessage] = useState("");
  const [model, setModel] = useState(getStoredModel);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const recentWorkspaceGroups = useMemo(() => buildRecentWorkspaceGroups(repoGroups), [repoGroups]);

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

  // Close on outside click (desktop only — Sheet handles its own dismissal on mobile)
  const closeRepoPicker = useCallback(() => {
    setRepoPickerOpen(false);
    setRepoFilter("");
  }, []);

  useEffect(() => {
    if (isMobile || !repoPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target as Node)) {
        closeRepoPicker();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isMobile, repoPickerOpen, closeRepoPicker]);

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
    if (isMobile || !modelPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isMobile, modelPickerOpen]);

  const modelLabel = getModelLabel(model);
  const selectedModelOption = getModelOption(model);

  const handleSelectModel = useCallback((value: string) => {
    setModel(value);
    setStoredModel(value);
    setModelPickerOpen(false);
  }, []);

  // ── Send ────────────────────────────────────────────────────────
  const hasContent = message.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !!selectedRepoId && !isSubmitting;

  const handleSend = useCallback(async () => {
    if (!canSend || !selectedRepoId) return;
    const content = buildCombinedContent();
    if (!content) return;
    setIsSubmitting(true);
    try {
      onSendMessage(selectedRepoId, content, model, selectedBranch ?? undefined);
      clearAttachments();
      setMessage("");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSend,
    selectedRepoId,
    buildCombinedContent,
    model,
    selectedBranch,
    onSendMessage,
    clearAttachments,
    isSubmitting,
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
      if (!selectedRepoId || isSubmitting) return;
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
    [selectedRepoId, isSubmitting]
  );

  // Auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`;
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center overflow-y-auto">
      {/* Top spacer — keeps the input high enough that recent workspaces can breathe below. */}
      <div className="flex-[0_0_14%] sm:flex-[0_0_18%]" />

      <motion.h1
        key={hasRepos ? "has-repos" : "zero-repos"}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT_QUART }}
        className="text-text-primary mb-6 w-full max-w-[720px] px-4 text-center text-2xl font-medium tracking-tight sm:px-6"
      >
        {hasRepos ? "What are we building?" : "Start with a project"}
      </motion.h1>

      {/* Input Card — the gravitational center */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.06, ease: EASE_OUT_QUART }}
        className="w-full max-w-[720px] px-4 sm:px-6"
      >
        <div
          className={cn(
            "bg-bg-raised dark:bg-bg-surface relative overflow-visible rounded-2xl p-1 transition-shadow duration-200",
            isDragging && "ring-primary/25 ring-2"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!hasRepos || isSubmitting) return;
            if (!isDragging) setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!hasRepos || isSubmitting) {
              setIsDragging(false);
              return;
            }
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
            if (!hasRepos || isSubmitting) return;
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
          {/* Context bar — repo picker + branch picker, on tray surface above the inner card */}
          <div className="flex items-center justify-between px-1 py-0.5">
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

                {/* Mobile: bottom sheet */}
                {isMobile ? (
                  <Sheet
                    open={repoPickerOpen}
                    onOpenChange={(v) => {
                      setRepoPickerOpen(v);
                      if (!v) setRepoFilter("");
                    }}
                  >
                    <SheetContent side="bottom" className="rounded-t-xl px-0">
                      <SheetHeader className="px-4 pb-0">
                        <SheetTitle className="text-sm">Select repository</SheetTitle>
                        <SheetDescription className="sr-only">
                          Choose a repository for your workspace
                        </SheetDescription>
                      </SheetHeader>

                      {/* Filter input */}
                      <div className="border-border-subtle flex items-center gap-2 border-b px-3 py-2">
                        <Search className="text-text-disabled size-3.5 shrink-0" />
                        <input
                          type="text"
                          value={repoFilter}
                          onChange={(e) => setRepoFilter(e.target.value)}
                          placeholder="Search repos..."
                          className="text-text-primary placeholder:text-text-disabled w-full bg-transparent text-sm outline-none"
                        />
                      </div>

                      {/* Repo list */}
                      <div className="max-h-[50vh] overflow-y-auto py-1">
                        {filteredRepos.length === 0 && (
                          <div className="text-text-disabled px-3 py-3 text-center text-sm">
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
                                "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors duration-100",
                                "hover:bg-bg-raised/45",
                                isSelected ? "text-text-primary" : "text-text-secondary"
                              )}
                            >
                              <div className="flex items-center gap-2 overflow-hidden">
                                {isSelected ? (
                                  <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
                                    <span className="bg-accent-green/25 absolute -inset-px rounded-full blur-[1.5px]" />
                                    <span className="bg-accent-green relative h-1.5 w-1.5 rounded-full" />
                                  </span>
                                ) : (
                                  <span className="h-1.5 w-1.5 shrink-0" />
                                )}
                                <span className="truncate font-medium">{repo.name}</span>
                              </div>
                              {isSelected && (
                                <Check className="text-text-primary size-3.5 shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* Add repo actions */}
                      <div className="border-border-subtle border-t py-1">
                        {onStartNewProject && (
                          <button
                            type="button"
                            onClick={() => {
                              closeRepoPicker();
                              onStartNewProject();
                            }}
                            className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-100"
                          >
                            <FolderGit2 className="size-4 shrink-0" />
                            <span>Start new project</span>
                          </button>
                        )}
                        {onCloneRepository && (
                          <button
                            type="button"
                            onClick={() => {
                              closeRepoPicker();
                              onCloneRepository();
                            }}
                            className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-100"
                          >
                            <GitBranch className="size-4 shrink-0" />
                            <span>Clone from GitHub</span>
                          </button>
                        )}
                        {capabilities.nativeFolderPicker && onOpenProject && (
                          <button
                            type="button"
                            onClick={() => {
                              closeRepoPicker();
                              onOpenProject();
                            }}
                            className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-100"
                          >
                            <FolderOpen className="size-4 shrink-0" />
                            <span>Open local...</span>
                          </button>
                        )}
                      </div>
                    </SheetContent>
                  </Sheet>
                ) : (
                  /* Desktop: animated dropdown */
                  <AnimatePresence>
                    {repoPickerOpen && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: -4 }}
                        transition={{ duration: 0.15, ease: [0.215, 0.61, 0.355, 1] }}
                        className={cn(
                          "absolute top-full left-0 z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border",
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
                        <div className="max-h-[224px] overflow-y-auto py-1">
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
                          {onStartNewProject && (
                            <button
                              type="button"
                              onClick={() => {
                                closeRepoPicker();
                                onStartNewProject();
                              }}
                              className="text-text-muted hover:text-text-secondary hover:bg-bg-raised/45 flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-100"
                            >
                              <FolderGit2 className="size-3 shrink-0" />
                              <span>Start new project</span>
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
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                )}
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

          {/* Inner card — typing surface (textarea + bottom toolbar) */}
          <div className="bg-bg-elevated relative overflow-visible rounded-xl transition-shadow duration-200 focus-within:shadow-sm">
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
              disabled={!hasRepos || isSubmitting}
              aria-label="Message to start a new workspace"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={3}
              className={cn(
                "text-text-primary placeholder:text-text-disabled w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none",
                "max-h-48 min-h-[76px] overflow-y-auto",
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
                  <AgentLogo
                    type={selectedModelOption?.agentHarness ?? "claude"}
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

                {/* Mobile: bottom sheet */}
                {isMobile ? (
                  <Sheet open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                    <SheetContent side="bottom" className="rounded-t-xl px-0">
                      <SheetHeader className="px-4 pb-0">
                        <SheetTitle className="text-sm">Select model</SheetTitle>
                        <SheetDescription className="sr-only">
                          Choose an AI model for your workspace
                        </SheetDescription>
                      </SheetHeader>
                      <div className="max-h-[50vh] overflow-y-auto p-2">
                        {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => (
                          <div key={agentConfig.id}>
                            {groupIdx > 0 && <div className="bg-border/70 mx-2 my-2 h-px" />}
                            <div className="text-text-muted/90 px-2 py-1.5 text-xs font-normal tracking-wide">
                              {agentConfig.label}
                            </div>
                            {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map(
                              (option) => {
                                const isSelected = selectedModelOption?.value === option.value;
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => handleSelectModel(option.value)}
                                    className={cn(
                                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-sm transition-colors duration-100",
                                      "hover:bg-bg-raised/45",
                                      isSelected ? "text-text-primary" : "text-text-secondary"
                                    )}
                                  >
                                    <AgentLogo type={option.agentHarness} className="h-4 w-4" />
                                    <span className="font-normal">{option.label}</span>
                                    {option.isNew && (
                                      <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted text-2xs rounded-xs border px-1 py-px tracking-wide uppercase">
                                        New
                                      </span>
                                    )}
                                    <span className="ml-auto">
                                      {isSelected && (
                                        <Check className="text-text-primary size-3.5" />
                                      )}
                                    </span>
                                  </button>
                                );
                              }
                            )}
                          </div>
                        ))}
                      </div>
                    </SheetContent>
                  </Sheet>
                ) : (
                  /* Desktop: animated dropdown */
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
                              {agentConfig.label}
                            </div>
                            {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map(
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
                      </motion.div>
                    )}
                  </AnimatePresence>
                )}
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
                {isSubmitting ? (
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Quick Prompts — chip row below input card (only when repos exist) */}
      <AnimatePresence>
        {hasRepos && !message.trim() && recentWorkspaceGroups.length === 0 && (
          <motion.div
            key="quick-prompts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, delay: 0.12, ease: EASE_OUT_QUART }}
            className="mt-3 flex w-full max-w-[720px] flex-wrap gap-2 px-4 sm:px-6"
          >
            {QUICK_PROMPTS.map((prompt, i) => (
              <motion.button
                key={prompt}
                type="button"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: 0.14 + i * 0.04, ease: EASE_OUT_QUART }}
                onClick={() => handleQuickPrompt(prompt)}
                disabled={!selectedRepoId || isSubmitting}
                className={cn(
                  "bg-bg-raised dark:bg-bg-surface text-text-muted rounded-lg px-3 py-2 text-xs transition-colors duration-150",
                  "hover:bg-bg-muted dark:hover:bg-bg-elevated hover:text-text-secondary",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                {prompt}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hasRepos && !message.trim() && recentWorkspaceGroups.length > 0 && (
          <RecentWorkspaces
            groups={recentWorkspaceGroups}
            selectedWorkspaceId={selectedWorkspaceId}
            onWorkspaceClick={onWorkspaceClick}
          />
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
            className="mt-6 w-full max-w-[560px] px-4 sm:px-6"
          >
            <p className="text-text-muted mb-4 text-sm">
              Add a project to start working with your AI coding agent.
            </p>

            <div className="border-border-subtle bg-bg-elevated/60 overflow-hidden rounded-xl border">
              {onStartNewProject && (
                <button
                  type="button"
                  onClick={onStartNewProject}
                  className="hover:bg-bg-raised/40 flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors duration-150"
                >
                  <div className="bg-bg-muted mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <FolderGit2 className="text-text-tertiary h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-text-primary text-sm font-medium">Start a new project</h3>
                    <p className="text-text-muted mt-0.5 text-xs">
                      Create a project from scratch or a template
                    </p>
                  </div>
                </button>
              )}

              {onStartNewProject && onCloneRepository && (
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

              {capabilities.nativeFolderPicker &&
                onOpenProject &&
                (onCloneRepository || onStartNewProject) && (
                  <div className="border-border-subtle/50 mx-4 border-t" />
                )}

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
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer actions — sticky so long recent lists still leave project actions visible. */}
      <AnimatePresence>
        {hasRepos && (
          <motion.div
            key="footer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, delay: 0.25, ease: EASE_OUT_QUART }}
            className="from-bg-surface via-bg-surface/95 pointer-events-none sticky bottom-0 z-20 mt-auto flex w-full justify-center bg-gradient-to-t to-transparent pt-12 pb-6"
          >
            <div className="pointer-events-auto flex items-center gap-3">
              {onStartNewProject && (
                <>
                  <button
                    type="button"
                    onClick={onStartNewProject}
                    className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors duration-150 hover:underline"
                  >
                    Start new project
                  </button>
                  {(onCloneRepository || (capabilities.nativeFolderPicker && onOpenProject)) && (
                    <span className="bg-foreground/10 inline-block h-1 w-1 rounded-full" />
                  )}
                </>
              )}
              {onCloneRepository && (
                <>
                  <button
                    type="button"
                    onClick={onCloneRepository}
                    className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors duration-150 hover:underline"
                  >
                    Clone from GitHub
                  </button>
                  {capabilities.nativeFolderPicker && onOpenProject && (
                    <span className="bg-foreground/10 inline-block h-1 w-1 rounded-full" />
                  )}
                </>
              )}
              {capabilities.nativeFolderPicker && onOpenProject && (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors duration-150 hover:underline"
                >
                  Open local project
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
