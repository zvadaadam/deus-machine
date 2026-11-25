import { Collapse } from "@/components/ui/collapse";
import { useState, useCallback, useRef, useMemo, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { ArrowUp, FolderGit2, FolderOpen, GitBranch } from "lucide-react";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { cn } from "@/shared/lib/utils";
import { useHomeComposer } from "@/features/session/hooks/useSessionComposer";
import {
  extractImagesFromClipboard,
  buildMessageContent,
} from "@/features/session/lib/imageAttachments";
import { attachImageFiles, HOME_COMPOSER_ID } from "@/features/session/store/sessionComposerStore";
import { returnContentToComposer } from "@/features/session/lib/returnToComposer";
import { ImageDropTarget } from "@/features/session/ui/ImageDropTarget";
import { MissingAttachments } from "@/features/session/ui/MissingAttachments";
import { PastedImageCard } from "@/features/session/ui/PastedImageCard";
import type { RepoGroup, Workspace } from "@/shared/types";
import type { Repository } from "../types";
import { tempo } from "@/shared/lib/tempo";
import { RecentWorkspaces, buildRecentWorkspaceGroups } from "./RecentWorkspaces";
import { CloudToggle, BranchPickerButton } from "./composer/ComposerControls";
import { RepoPicker } from "./composer/RepoPicker";
import { useNewChatSelection } from "./composer/useNewChatSelection";
import { useComposerLocation } from "./composer/useComposerLocation";
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import type { ThinkingLevel } from "@/shared/agents";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";
import { FIRST_MESSAGE_PLACEHOLDER } from "@/features/workspace/lib/newWorkspace";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { addProjectActions, composerProjects, type AddProjectAction } from "../lib/addProject";
import { cloudOnlyReason, cloudOnlySendBlock } from "../lib/cloudControl";
import { useRepoBranches } from "@/features/workspace/api";
import { toast } from "sonner";

// ── Persistence ─────────────────────────────────────────────────────
const LAST_REPO_KEY = "deus:welcome-last-repo";

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

// ── Quick Prompts ───────────────────────────────────────────────────
const QUICK_PROMPTS = [
  "Find and fix bugs",
  "Write missing tests",
  "Explain this codebase",
  "Clean up the code",
  "Update dependencies",
];

// ── Types ───────────────────────────────────────────────────────────
interface HomeViewProps {
  repos: Repository[];
  repoGroups?: RepoGroup[];
  /** Web-direct discovery state: loading and a failed load are not an empty account. */
  repoGroupsLoading?: boolean;
  repoGroupsError?: string | null;
  selectedWorkspaceId?: string | null;
  onSendMessage: (
    repoId: string,
    message: string,
    model: string,
    branch?: string,
    location?: "local" | "cloud",
    /** The thinking level picked here; absent for a model with no thinking control. */
    thinkingLevel?: ThinkingLevel,
    /** In the cloud, the organization it starts in (the composer's). */
    organizationId?: string | null
  ) => Promise<boolean>;
  onWorkspaceClick?: (workspace: Workspace) => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  onStartNewProject?: () => void;
  /**
   * The cloud's add dialog, for an organization (the composer's, from its
   * project picker); the window's when none is given.
   */
  onAddFromGitHub?: (organizationId?: string | null) => void;
  /** The ways to add a project by the window's place (the zero state and the footer). */
  addActions?: AddProjectAction[];
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
  repoGroupsLoading = false,
  repoGroupsError = null,
  selectedWorkspaceId = null,
  onSendMessage,
  onWorkspaceClick,
  onOpenProject,
  onCloneRepository,
  onStartNewProject,
  onAddFromGitHub,
  addActions: windowAddActions,
}: HomeViewProps) {
  const hasRepos = repos.length > 0;

  // What sent the user here may name a project to start in and a draft to
  // start from (a project's "+", a starter prompt, a message handed back).
  const request = useUIStore((s) => s.newWorkspaceRequest);

  // ── Input state ─────────────────────────────────────────────────
  const {
    draft: message,
    setDraft: setMessage,
    imageAttachments: attachments,
    removeImageAttachment: removeAttachment,
    missingPictures,
    missingPastedTexts,
    dismissMissingAttachments,
    clearSent,
  } = useHomeComposer();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = extractImagesFromClipboard(e);
    if (!files.length) return;
    e.preventDefault();
    await attachImageFiles(HOME_COMPOSER_ID, files);
  };

  // ── Repo selection ──────────────────────────────────────────────
  // User-chosen repo ID — null means "use derived default"
  // Only a deliberate choice (picked, or named by what sent the user here);
  // the last project used is the derived default, if it can run where the
  // composer points.
  const [userRepoId, setUserRepoId] = useState<string | null>(
    // Not checked against `repos`: a project added a moment ago is not listed yet.
    () => request?.repoId ?? null
  );

  if (request?.repoId && request.repoId !== userRepoId) setUserRepoId(request.repoId);
  useLayoutEffect(() => {
    if (!request || useUIStore.getState().newWorkspaceRequest !== request) return;
    if (request.draft !== undefined) setMessage(request.draft);
    if (request.returnedMessage !== undefined)
      void returnContentToComposer(HOME_COMPOSER_ID, request.returnedMessage);
    if (request.repoId) setStoredRepoId(request.repoId);
    // Not cancelled on cleanup: clearing the request runs this effect again.
    setTimeout(() => textareaRef.current?.focus(), 50);
    uiActions.clearNewWorkspaceRequest();
  }, [request, setMessage]);

  // Where the new workspace runs: local worktree (default) or agnt cloud
  // sandbox. Starts from the window's place (cloud only when ready there) and
  // follows it.
  const composerPlace = useComposerLocation();
  const { setLocation } = composerPlace;

  // The projects the composer offers follow where it points (the sidebar's
  // rule), and so does its preselection: user pick > stored > first that runs.
  const [shownRepoId, setShownRepoId] = useState<string | null>(null);
  const { listed: pickerRepos, selectedId: selectedRepoId } = useMemo(
    () =>
      composerProjects(repos, composerPlace.location, {
        chosen: userRepoId,
        shown: shownRepoId,
        stored: getStoredRepoId(),
      }),
    [repos, composerPlace.location, userRepoId, shownRepoId]
  );
  if (selectedRepoId !== shownRepoId) setShownRepoId(selectedRepoId);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selectedRepoId) ?? null,
    [repos, selectedRepoId]
  );

  const recentWorkspaceGroups = useMemo(() => buildRecentWorkspaceGroups(repoGroups), [repoGroups]);

  // ── Branch selection ──────────────────────────────────────────────
  // A project with no folder on this computer runs only in the cloud: the
  // switch is on and cannot be turned off, whatever the composer's own choice.
  const lockedReason = cloudOnlyReason(selectedRepo);
  const location = lockedReason ? "cloud" : composerPlace.location;
  const cloudOrganizationId =
    location === "cloud" ? (composerPlace.organization?.id ?? null) : null;
  const ignoreLocation = useCallback(() => {}, []);
  // The model and thinking level the new chat runs on.
  const selection = useNewChatSelection(location);

  // Adding a project follows the place: the picker the composer's, the rest the window's.
  const folderPicker = { nativeFolderPicker: capabilities.nativeFolderPicker };
  const pickerActions = addProjectActions(location, folderPicker);
  const windowActions = windowAddActions ?? addProjectActions("local", folderPicker);
  const addCards: Record<
    AddProjectAction,
    { icon: typeof FolderOpen; title: string; hint: string; link: string; run?: () => void }
  > = {
    "start-new": {
      icon: FolderGit2,
      title: "Start a new project",
      hint: "Create a project from scratch or a template",
      link: "Start new project",
      run: onStartNewProject,
    },
    clone: {
      icon: GitBranch,
      title: "Clone from GitHub",
      hint: "Paste a repository URL or search your GitHub repos",
      link: "Clone from GitHub",
      run: onCloneRepository,
    },
    "open-local": {
      icon: FolderOpen,
      title: "Open a local project",
      hint: "Browse your filesystem for an existing codebase",
      link: "Open local project",
      run: onOpenProject,
    },
    "add-from-github": {
      icon: GitHubIcon as typeof FolderOpen,
      title: "Add from GitHub",
      hint: "A repository to work on in the cloud, without cloning it here",
      link: "Add from GitHub",
      run: () => onAddFromGitHub?.(),
    },
  };
  const [branchSelection, setBranchSelection] = useState<{ repoId: string; branch: string } | null>(
    null
  );
  const selectedBranch = branchSelection?.repoId === selectedRepoId ? branchSelection.branch : null;
  // A project with no folder here: GitHub names its default branch (listed first).
  const githubBranches = useRepoBranches(lockedReason ? selectedRepoId : null, cloudOrganizationId);
  const defaultBranch =
    (lockedReason ? githubBranches.data?.branches[0]?.name : undefined) ??
    selectedRepo?.git_default_branch ??
    "main";
  const displayBranch = selectedBranch ?? defaultBranch;

  const handleSelectRepo = useCallback((repoId: string) => {
    setUserRepoId(repoId);
    setStoredRepoId(repoId);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // ── Send ────────────────────────────────────────────────────────
  const hasContent = message.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !!selectedRepoId && !!selection.model && !isSubmitting;

  // A project that runs only in the cloud, where the cloud cannot be used now.
  const sendBlock = cloudOnlySendBlock({
    repo: selectedRepo,
    cloudReady: composerPlace.cloudReady,
    organizationName: composerPlace.organization?.name ?? null,
  });

  const handleSend = useCallback(async () => {
    if (!canSend || !selectedRepoId || !selection.model) return;
    if (sendBlock) {
      toast.error(sendBlock);
      return;
    }
    const content = buildMessageContent(message.trim(), attachments);
    if (!content) return;
    setIsSubmitting(true);
    try {
      // The message stays in the composer until its workspace exists: one that
      // could not be created (the reason is toasted) is still here to send again.
      const started = await onSendMessage(
        selectedRepoId,
        content,
        selection.model,
        selectedBranch ?? undefined,
        location,
        selection.sentThinkingLevel,
        cloudOrganizationId
      );
      if (!started) return;
      clearSent();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSend,
    selectedRepoId,
    sendBlock,
    message,
    attachments,
    selection.model,
    selection.sentThinkingLevel,
    selectedBranch,
    location,
    cloudOrganizationId,
    onSendMessage,
    clearSent,
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
    [selectedRepoId, isSubmitting, setMessage]
  );

  // Auto-resize textarea
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMessage(e.target.value);
      const ta = e.target;
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`;
    },
    [setMessage]
  );

  // Fully Mac-closed web: there is no local project to start from — the home
  // is the user's cloud sessions (the sidebar's rows, surfaced) or an honest
  // pointer to where new ones come from. Every other affordance on this screen
  // (repo picker, clone, new project, composer) needs the Mac backend.
  if (isCloudDirectWebMode()) {
    return (
      <CloudSessionsHome
        groups={recentWorkspaceGroups}
        selectedWorkspaceId={selectedWorkspaceId}
        onWorkspaceClick={onWorkspaceClick}
        loading={repoGroupsLoading}
        error={repoGroupsError}
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col items-center overflow-hidden">
      {/* Top spacer — keeps the input high enough that recent workspaces can breathe below. */}
      <div className="flex-[0_0_14%] shrink-0 sm:flex-[0_0_18%]" />

      <h1
        key={hasRepos ? "has-repos" : "zero-repos"}
        className="enter-step text-text-primary mb-6 w-full max-w-[720px] px-4 text-center text-2xl font-medium tracking-tight [--enter-y:8px] sm:px-6"
      >
        {hasRepos ? "What are we building?" : "Start with a project"}
      </h1>

      {/* Input Card — the gravitational center */}
      <div className="enter-step w-full max-w-[720px] px-4 [--enter-y:12px] [--step:1] sm:px-6">
        <ImageDropTarget
          composerId={HOME_COMPOSER_ID}
          disabled={!hasRepos || isSubmitting}
          className="bg-bg-raised dark:bg-bg-surface overflow-visible rounded-2xl p-1 transition-shadow"
        >
          {/* Context bar — repo + branch grouped left, cloud toggle right */}
          <div className="flex items-center justify-between px-1 py-0.5">
            <div className="flex min-w-0 items-center">
              {/* Repo picker trigger */}
              {hasRepos ? (
                <RepoPicker
                  repos={pickerRepos}
                  selectedRepo={selectedRepo}
                  onSelect={handleSelectRepo}
                  addActions={pickerActions}
                  onOpenProject={onOpenProject}
                  onCloneRepository={onCloneRepository}
                  onStartNewProject={onStartNewProject}
                  onAddFromGitHub={() => onAddFromGitHub?.(composerPlace.organization?.id ?? null)}
                />
              ) : (
                /* Zero repos — "Add a project" label */
                <span className="text-text-muted flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                  <FolderOpen className="size-3" />
                  <span className="font-medium">Add a project</span>
                </span>
              )}

              {/* Branch picker — beside the repo it belongs to */}
              {hasRepos && selectedRepoId && (
                <BranchPickerButton
                  repoId={selectedRepoId}
                  organizationId={cloudOrganizationId}
                  displayBranch={displayBranch}
                  onBranchSelect={(name) => {
                    if (name === defaultBranch) {
                      setBranchSelection(null);
                    } else if (selectedRepoId) {
                      setBranchSelection({ repoId: selectedRepoId, branch: name });
                    }
                  }}
                />
              )}
            </div>

            {/* Cloud toggle (right) — off by default; on = agnt sandbox */}
            {hasRepos && (
              <CloudToggle
                location={location}
                onLocationChange={lockedReason ? ignoreLocation : setLocation}
                lockedReason={lockedReason}
                repoId={selectedRepoId || null}
                organization={composerPlace.organization}
                organizations={composerPlace.organizations}
                onOrganizationChange={composerPlace.setOrganization}
                cloudReady={composerPlace.cloudReady}
                withTooltip
              />
            )}
          </div>

          {/* Inner card — typing surface (textarea + bottom toolbar) */}
          <div className="bg-bg-elevated relative overflow-visible rounded-xl transition-shadow focus-within:shadow-sm">
            <MissingAttachments
              pictures={missingPictures}
              pastedTexts={missingPastedTexts}
              onDismiss={dismissMissingAttachments}
            />
            {/* Image previews — shown above textarea when images are pasted/dropped */}
            <AnimatePresence>
              {attachments.length > 0 && (
                <Collapse className="flex gap-2 overflow-x-auto px-3 pt-3">
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
                </Collapse>
              )}
            </AnimatePresence>

            {/* Textarea — the hero input */}
            <textarea
              ref={textareaRef}
              value={message}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={hasRepos ? FIRST_MESSAGE_PLACEHOLDER : "Add a project to get started"}
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
              <ModelPicker
                model={selection.model}
                agentHarness={selection.agentHarness}
                lists={selection.lists}
                thinkingLevel={selection.thinkingLevel}
                thinkingLevels={selection.thinkingLevels}
                hasMessages={false}
                onModelChange={selection.setModel}
                onThinkingLevelChange={selection.setThinkingLevel}
                side="bottom"
              />

              {/* Send button */}
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send message"
                title={selection.unavailable ?? "Send message (Enter)"}
                className={cn(
                  "control-interaction mr-1 flex h-7 w-7 items-center justify-center rounded-full",
                  canSend
                    ? "bg-button-primary text-button-primary-foreground hover:opacity-90"
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
        </ImageDropTarget>
      </div>

      {/* Quick Prompts — chip row below input card (only when repos exist) */}
      <AnimatePresence>
        {hasRepos && !message.trim() && recentWorkspaceGroups.length === 0 && (
          <motion.div
            key="quick-prompts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4, transition: tempo.moderate.exit }}
            transition={{ ...tempo.moderate, delay: 2 * tempo.step }}
            className="mt-3 flex w-full max-w-[720px] flex-wrap gap-2 px-4 sm:px-6"
          >
            {QUICK_PROMPTS.map((prompt, i) => (
              <button
                key={prompt}
                type="button"
                style={{ "--step": 2 + i } as React.CSSProperties}
                onClick={() => handleQuickPrompt(prompt)}
                disabled={!selectedRepoId || isSubmitting}
                className={cn(
                  "enter-step [--enter-time:var(--tempo-moderate)] [--enter-y:4px]",
                  "bg-bg-raised dark:bg-bg-surface text-text-muted rounded-lg px-3 py-2 text-xs transition-colors",
                  "hover:bg-bg-muted dark:hover:bg-bg-elevated hover:text-text-secondary",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                {prompt}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Scrollable middle — recents (or zero state) get their own scroll container
       * so the input + header stay pinned at the top. The footer below is absolutely
       * positioned over this area; pb-32 gives the last item room to scroll past
       * the button row instead of staying stuck behind the gradient. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-32">
        <AnimatePresence>
          {hasRepos && recentWorkspaceGroups.length > 0 && (
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
              exit={{ opacity: 0, y: 12, transition: tempo.slow.exit }}
              transition={{ ...tempo.slow, delay: 3 * tempo.step }}
              className="mt-6 w-full max-w-[560px] px-4 sm:px-6"
            >
              <p className="text-text-muted mb-4 text-sm">
                Add a project to start working with your AI coding agent.
              </p>

              <div className="border-border-subtle bg-bg-elevated/60 overflow-hidden rounded-xl border">
                {windowActions.map((action, index) => {
                  const card = addCards[action];
                  const Icon = card.icon;
                  return (
                    <div key={action}>
                      {index > 0 && <div className="border-border-subtle/50 mx-4 border-t" />}
                      <button
                        type="button"
                        onClick={card.run}
                        className="hover:bg-bg-raised/40 flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors"
                      >
                        <div className="bg-bg-muted mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                          <Icon className="text-text-tertiary h-4 w-4" />
                        </div>
                        <div>
                          <h3 className="text-text-primary text-sm font-medium">{card.title}</h3>
                          <p className="text-text-muted mt-0.5 text-xs">{card.hint}</p>
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer actions — absolute so the recents scroll container above
       * fills the full viewport and items can fade behind the buttons. */}
      <AnimatePresence>
        {hasRepos && (
          <motion.div
            key="footer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: tempo.slow.exit }}
            transition={{ ...tempo.slow, delay: 4 * tempo.step }}
            className="home-footer-fade pointer-events-none absolute right-0 bottom-0 left-0 z-20 flex w-full justify-center pt-24 pb-6"
          >
            <div className="pointer-events-auto flex items-center gap-3">
              {windowActions.map((action, index) => (
                <span key={action} className="flex items-center gap-3">
                  {index > 0 && (
                    <span className="bg-foreground/10 inline-block h-1 w-1 rounded-full" />
                  )}
                  <button
                    type="button"
                    onClick={addCards[action].run}
                    className="text-text-disabled hover:text-text-muted text-xs underline-offset-4 transition-colors hover:underline"
                  >
                    {addCards[action].link}
                  </button>
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Web-direct home ─────────────────────────────────────────────────
const DESKTOP_DOWNLOAD_URL = "https://github.com/zvadaadam/deus-machine/releases";

/**
 * The home for a browser with no Mac behind it: the cloud sessions discovery
 * found, or — for a brand-new account — where to start one. Sessions are
 * created from the desktop app for now (creation needs the Mac backend), so
 * the empty state says exactly that instead of offering dead controls.
 */
const CLOUD_HOME_COPY = {
  loading: ["Loading your cloud sessions…", "Fetching them from Deus Cloud."],
  error: ["Couldn't load your cloud sessions", "Discovery failed."],
  sessions: [
    "Your cloud sessions",
    "Start a session in the Deus desktop app. This list refreshes every minute and when you return to this tab.",
  ],
  empty: [
    "No cloud sessions yet",
    "Start one from the Deus desktop app — it shows up here, and you can keep the conversation going from any browser or your phone.",
  ],
} as const;

function CloudSessionsHome({
  groups,
  selectedWorkspaceId,
  onWorkspaceClick,
  loading,
  error,
}: {
  groups: ReturnType<typeof buildRecentWorkspaceGroups>;
  selectedWorkspaceId: string | null;
  onWorkspaceClick?: (workspace: Workspace) => void;
  /** Discovery in flight. */
  loading: boolean;
  /** Discovery failed (the message). */
  error: string | null;
}) {
  const queryClient = useQueryClient();
  const hasSessions = groups.length > 0;
  // Loading and a failed load are NOT the empty state: on a cold load the
  // groups are [] for a beat, and the empty screen would tell a user with
  // sessions to go download the desktop app. A failed BACKGROUND refresh
  // keeps the cached list on screen: the error screen is for having nothing.
  const state = loading ? "loading" : hasSessions ? "sessions" : error ? "error" : "empty";
  const [title, subtitle] = CLOUD_HOME_COPY[state];
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col items-center overflow-hidden">
      <div className="flex-[0_0_14%] shrink-0 sm:flex-[0_0_18%]" />
      <h1
        key={state}
        className="enter-step text-text-primary mb-2 w-full max-w-[720px] px-4 text-center text-2xl font-medium tracking-tight [--enter-y:8px] sm:px-6"
      >
        {title}
      </h1>
      <p className="enter-step text-text-muted mb-8 w-full max-w-[560px] px-4 text-center text-sm [--enter-y:8px] [--step:1] sm:px-6">
        {state === "error" && error ? error : subtitle}
      </p>
      {state === "error" && (
        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })}
          className="enter-step control-interaction bg-button-primary text-button-primary-foreground hover:bg-button-primary/90 active:bg-button-primary/80 rounded-lg px-4 py-2 text-sm font-normal [--enter-time:var(--tempo-moderate)] [--enter-y:8px] [--step:2]"
        >
          Try again
        </button>
      )}
      {state === "empty" && (
        <a
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="enter-step control-interaction bg-button-primary text-button-primary-foreground hover:bg-button-primary/90 active:bg-button-primary/80 rounded-lg px-4 py-2 text-sm font-normal [--enter-time:var(--tempo-moderate)] [--enter-y:8px] [--step:2]"
        >
          Download Deus for macOS
        </a>
      )}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-32">
        <AnimatePresence>
          {state === "sessions" && (
            <RecentWorkspaces
              groups={groups}
              selectedWorkspaceId={selectedWorkspaceId}
              onWorkspaceClick={onWorkspaceClick}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
