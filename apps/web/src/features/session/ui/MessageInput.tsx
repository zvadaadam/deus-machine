/**
 * MessageInput — the chat composer pill.
 *
 * Session-aware presentational view: all staged content (draft, pastes,
 * inspected elements, file/skill mentions, image attachments, model,
 * thinking level, plan mode) is read from `sessionComposerStore` keyed
 * by `sessionId`. Two surfaces rendering with the same sessionId — main
 * chat, focus-mode overlay, activity modal — see and mutate the same
 * state in real time.
 *
 * What DOES live locally here:
 *   - @ file-picker popover open/close + query + highlighted row
 *   - / slash-command popover open/close + query + highlighted row
 *   - textarea cursor / focus / scroll (implicit in DOM)
 * These are per-interaction UI ephemera — they shouldn't cross surfaces.
 *
 * The parent submits the message. Its acknowledgement clears this input’s
 * submitted snapshot, even if more was staged in the meantime.
 */

import { tempo } from "@/shared/lib/tempo";
import { Collapse } from "@/components/ui/collapse";
import { useEffect } from "react";
import type { SessionStatus } from "@/shared/types";
import { agentConfigOf } from "@/features/workspace/lib/reach";
import { locationOf } from "@/features/sidebar/lib/location";
import { ACTIVE_TURN_STATUSES, type WorkspaceKind } from "@shared/enums";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2, ArrowUp, Square, Wrench } from "lucide-react";
import { useFileMention } from "../hooks/useFileMention";
import { useCloudSlashItems } from "../hooks/useCloudSlashItems";
import { useSlashCommand } from "../hooks/useSlashCommand";
import { attachImageFiles } from "../store/sessionComposerStore";
import { useSessionComposer } from "../hooks/useSessionComposer";
import { FileMentionPopover } from "./FileMentionPopover";
import { SlashCommandPopover } from "./SlashCommandPopover";
import { setupEnvironmentPrompt } from "../lib/sessionPrompts";
import { extractImagesFromClipboard, buildMessageContent } from "../lib/imageAttachments";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { PastedTextCard } from "./PastedTextCard";
import { MissingPictures, PastedImageCard } from "./PastedImageCard";
import { InspectedElementCard } from "./InspectedElementCard";
import { FileMentionCard } from "./FileMentionCard";
import { SkillMentionCard } from "./SkillMentionCard";
import { serializeInspectElement } from "../lib/parseInspectTags";
import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  composerThinking,
  getAgentHarnessForModel,
  getModelId,
  modelThinkingLevels as thinkingLevelsOf,
  type AgentHarness,
  type ThinkingLevel,
} from "@/shared/agents";
import { useModelListsState } from "@/shared/hooks/useModelLists";
import { ModelPicker } from "./ModelPicker";
import { PlanModeToggle } from "./PlanModeToggle";
import { ContextTokenIndicator } from "./ContextTokenIndicator";

// Long pastes (20+ lines) are shown as collapsed cards instead of inline text
const PASTE_LINE_THRESHOLD = 20;

interface MessageInputProps {
  /** Active session — state lives in `sessionComposerStore[sessionId]`. */
  sessionId: string;
  /** Workspace ID for @ file fuzzy-search backend. */
  workspaceId?: string | null;
  /** Workspace root path for / slash-command discovery. */
  workspacePath?: string | null;
  /** Cloud sessions hide plan mode because the sidecar runs bypass. */
  workspaceKind?: WorkspaceKind | null;
  /** Seed initial model on first mount if the store doesn't have this
   *  session yet. Ignored afterwards. */
  initialModel?: string;

  sending: boolean;
  sessionStatus?: SessionStatus;
  contextTokenCount?: number;
  contextUsedPercent?: number;
  /** Whether the session already has messages (gates model-switch behaviour). */
  hasMessages?: boolean;
  /** True only after a successful lookup confirms there is no project recipe. */
  environmentUnconfigured?: boolean;
  showCompactButton?: boolean;

  onSend: (content: string) => boolean | Promise<boolean>;
  /** The draft can still be edited while its workspace starts. */
  sendDisabledReason?: string;
  onCompact?: () => void;
  onStop?: () => void;
  onOpenNewTab?: (initialModel?: string) => void;

  /** Replaces the default "Ask a follow-up…" hint. */
  placeholder?: string;
  /** Whether `@` lists the workspace's files. Off where there is no checkout
   *  to list yet (a workspace that is still starting). */
  fileMentionsEnabled?: boolean;

  /** The level the chat starts on (its latest turn's); `defaultThinking` without one. */
  initialThinking?: ThinkingLevel;

  /** User setting — default thinking level for new sessions / clamp target
   *  when switching to a model that doesn't support the current level. */
  defaultThinking?: ThinkingLevel;

  className?: string;
}

interface ComposerStagedContentProps {
  skillMentions: ReturnType<typeof useSessionComposer>["skillMentions"];
  inspectedElements: ReturnType<typeof useSessionComposer>["inspectedElements"];
  fileMentions: ReturnType<typeof useSessionComposer>["fileMentions"];
  imageAttachments: ReturnType<typeof useSessionComposer>["imageAttachments"];
  pastedTexts: ReturnType<typeof useSessionComposer>["pastedTexts"];
  onRemoveSkill: (id: string) => void;
  onRemoveInspectedElement: (id: string) => void;
  onRemoveFileMention: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemovePastedText: (id: string) => void;
}

function ComposerStagedContent({
  skillMentions,
  inspectedElements,
  fileMentions,
  imageAttachments,
  pastedTexts,
  onRemoveSkill,
  onRemoveInspectedElement,
  onRemoveFileMention,
  onRemoveImage,
  onRemovePastedText,
}: ComposerStagedContentProps) {
  const hasPills =
    skillMentions.length > 0 || inspectedElements.length > 0 || fileMentions.length > 0;
  const hasImages = imageAttachments.length > 0;
  const hasPastes = pastedTexts.length > 0;

  if (!hasPills && !hasImages && !hasPastes) return null;

  return (
    <div className="w-full px-3 pt-3">
      {hasPills && (
        <div className="flex flex-wrap items-start gap-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {skillMentions.map((mention) => (
              <SkillMentionCard
                key={mention.id}
                mention={mention}
                onRemove={() => onRemoveSkill(mention.id)}
              />
            ))}
            {inspectedElements.map((element) => (
              <InspectedElementCard
                key={element.id}
                element={element}
                onRemove={() => onRemoveInspectedElement(element.id)}
              />
            ))}
            {fileMentions.map((mention) => (
              <FileMentionCard
                key={mention.id}
                mention={mention}
                onRemove={() => onRemoveFileMention(mention.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {hasImages && (
        <div className={cn("flex gap-2 overflow-x-auto pt-2 pb-0.5", !hasPills && "pt-0")}>
          <AnimatePresence mode="popLayout" initial={false}>
            {imageAttachments.map((attachment) => (
              <PastedImageCard
                key={attachment.id}
                preview={attachment.preview}
                fileName={attachment.file.name}
                onRemove={() => onRemoveImage(attachment.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {hasPastes && (
        <div
          className={cn(
            "flex gap-2 overflow-x-auto pt-2 pb-0.5",
            !hasPills && !hasImages && "pt-0"
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {pastedTexts.map((paste) => (
              <PastedTextCard
                key={paste.id}
                content={paste.content}
                onRemove={() => onRemovePastedText(paste.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export function MessageInput({
  sessionId,
  workspaceId = null,
  workspacePath = null,
  workspaceKind = null,
  initialModel,
  sending,
  sessionStatus,
  contextTokenCount = 0,
  contextUsedPercent = 0,
  hasMessages = false,
  environmentUnconfigured = false,
  showCompactButton = false,
  onSend,
  sendDisabledReason,
  onCompact,
  onStop,
  onOpenNewTab,
  initialThinking,
  defaultThinking = DEFAULT_THINKING_LEVEL,
  placeholder,
  fileMentionsEnabled = true,
  className,
}: MessageInputProps) {
  const isMobile = useIsMobile();

  // Composer content — subscribed from the store, mutated via bound setters.
  const composer = useSessionComposer(sessionId, {
    initialModel: initialModel ?? DEFAULT_MODEL,
    initialThinking,
    defaultThinking,
  });

  const {
    draft,
    model,
    thinkingLevel,
    planModeEnabled,
    pastedTexts,
    inspectedElements,
    fileMentions,
    skillMentions,
    imageAttachments,
  } = composer;

  const agentHarness: AgentHarness = getAgentHarnessForModel(model);
  const isClaudeAgent = agentHarness === "claude-code";

  // The models and levels this chat chooses from: the platform's for a cloud
  // workspace, this computer's CLIs' otherwise.
  const { lists: modelLists, live: listIsLive } = useModelListsState({
    cloud: workspaceKind === "cloud",
    workspaceId,
  });
  const levelsFor = (value: string) =>
    thinkingLevelsOf(modelLists, getAgentHarnessForModel(value), getModelId(value));
  // The one rule for fitting a chat's level: only to a model whose list is live,
  // never to the catalog alone, when a model is shown and when one is chosen.
  const fittingLevels = (value: string) =>
    listIsLive(getAgentHarnessForModel(value)) ? levelsFor(value) : undefined;

  // Build combined message content from all staged sources.
  // See the big block-comment in the previous revision for ordering rationale
  // (skills first → inspected elements → file mentions → pastes → typed text,
  // then images appended as canonical `image` PartInputs).
  const buildCombinedContent = () => {
    const textParts: string[] = [];
    if (skillMentions.length > 0) {
      textParts.push(skillMentions.map((s) => `/${s.name}`).join(" "));
    }
    for (const el of inspectedElements) {
      textParts.push(serializeInspectElement(el));
    }
    if (fileMentions.length > 0) {
      textParts.push(fileMentions.map((fm) => `@${fm.path}`).join(" "));
    }
    for (const paste of pastedTexts) {
      textParts.push(paste.content);
    }
    const typed = draft.trim();
    if (typed) textParts.push(typed);
    const combinedText = textParts.join("\n\n");

    return buildMessageContent(combinedText, imageAttachments);
  };

  const hasContent =
    draft.trim().length > 0 ||
    pastedTexts.length > 0 ||
    imageAttachments.length > 0 ||
    inspectedElements.length > 0 ||
    fileMentions.length > 0 ||
    skillMentions.length > 0;

  const canSend = hasContent && !sending && !sendDisabledReason;
  const handleSend = async () => {
    if (!canSend) return;
    const combined = buildCombinedContent();
    if (combined && (await onSend(combined))) composer.clearSent();
  };

  // @ file mention popover — local UI-ephemeral state (open/close, query,
  // selected index). Picked files get pushed into the composer store.
  const fileMention = useFileMention({
    value: draft,
    workspaceId: fileMentionsEnabled ? (workspaceId ?? null) : null,
    onChange: composer.setDraft,
    onAddMention: (result) => composer.addFileMention({ path: result.path, name: result.name }),
  });

  // / slash command popover — same pattern. Picked skills → store. Rule 1: the
  // configuration where the agent runs; in the cloud, what reaches it from here.
  const agentConfig = agentConfigOf({
    kind: workspaceKind ?? "worktree",
    workspace_path: workspacePath ?? "",
    current_session_id: sessionId ?? null,
  });
  const cloudSlashItems = useCloudSlashItems(agentConfig.where === "cloud" && isClaudeAgent);
  const slashCommand = useSlashCommand({
    value: draft,
    config: agentConfig,
    cloudItems: cloudSlashItems,
    onChange: composer.setDraft,
    enabled: isClaudeAgent,
    onAddSkill: (skill) =>
      composer.addSkillMention({ name: skill.name, description: skill.description }),
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Popovers get first pass at arrow/enter/escape.
    if (slashCommand.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (fileMention.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (
      e.key === "Enter" &&
      !isMobile &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    // Images first: preventDefault + process via store.
    const imageFiles = extractImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      e.preventDefault();
      await attachImageFiles(sessionId, imageFiles);
      return;
    }
    // Long text paste: preventDefault + stash as a card. Short pastes fall
    // through to native textarea handling.
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const lineCount = text.split("\n").length;
    if (lineCount >= PASTE_LINE_THRESHOLD) {
      e.preventDefault();
      composer.addPastedText(text);
    }
  };

  const modelThinkingLevels = levelsFor(model);
  // A level the model lacks runs as the nearest it has: once the model list is
  // live, that is the one shown, and the chat keeps it, so what the picker shows
  // is what a send carries. Against the catalog alone the chat keeps its own.
  const fitTo = fittingLevels(model);
  const shownThinking = composerThinking(thinkingLevel, fitTo, defaultThinking);
  const live = fitTo !== undefined;
  const { setThinkingLevel } = composer;
  useEffect(() => {
    if (live && shownThinking !== thinkingLevel) setThinkingLevel(shownThinking);
  }, [live, shownThinking, thinkingLevel, setThinkingLevel]);

  // Suggest setup only in an empty, idle chat with a known missing recipe.
  const setupLocation = workspaceKind ? locationOf({ kind: workspaceKind }) : null;
  const showSetupNudge =
    setupLocation !== null &&
    environmentUnconfigured &&
    !hasMessages &&
    !sending &&
    (!sessionStatus || !ACTIVE_TURN_STATUSES.includes(sessionStatus));
  const handleSetupEnvironment = () => {
    if (setupLocation) onSend(setupEnvironmentPrompt(setupLocation));
  };

  // Local chats plan, on either agent; cloud sidecars run bypass.
  const showPlanMode = workspaceKind !== "cloud";
  return (
    <div className={cn("relative z-20 shrink-0 px-2 pb-2", className)}>
      <AnimatePresence initial={false}>
        {showSetupNudge && (
          <motion.div
            key="setup-nudge"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6, transition: tempo.moderate.exit }}
            transition={tempo.moderate}
            className="mb-2 flex"
          >
            <button
              type="button"
              onClick={handleSetupEnvironment}
              className="control-interaction text-text-muted hover:text-text-secondary border-border-subtle hover:border-border hover:bg-control-hover active:bg-control-pressed flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 text-sm"
            >
              <Wrench className="h-3 w-3 shrink-0" />
              <span>Set up this project</span>
              <span aria-hidden="true" className="text-text-disabled">
                &rarr;
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <InputGroup
        data-no-ring={true}
        className="bg-bg-muted/75 ring-border-subtle relative overflow-visible rounded-2xl border-0 shadow-sm ring-1 backdrop-blur-xl"
      >
        <MissingPictures
          count={composer.missingPictures}
          onDismiss={composer.dismissMissingPictures}
        />
        {sendDisabledReason && (
          <p className="text-text-muted w-full px-4 pt-2 text-xs">{sendDisabledReason}</p>
        )}
        <ComposerStagedContent
          skillMentions={skillMentions}
          inspectedElements={inspectedElements}
          fileMentions={fileMentions}
          imageAttachments={imageAttachments}
          pastedTexts={pastedTexts}
          onRemoveSkill={composer.removeSkillMention}
          onRemoveInspectedElement={composer.removeInspectedElement}
          onRemoveFileMention={composer.removeFileMention}
          onRemoveImage={composer.removeImageAttachment}
          onRemovePastedText={composer.removePastedText}
        />

        <AnimatePresence initial={false}>
          {slashCommand.isOpen && (
            <Collapse key="slash-command-sheet" tier="fast" className="w-full">
              <SlashCommandPopover
                results={slashCommand.results}
                loading={slashCommand.loading}
                selectedIndex={slashCommand.selectedIndex}
                query={slashCommand.query}
                onSelect={slashCommand.selectItem}
              />
            </Collapse>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {fileMention.isOpen && (
            <Collapse key="file-mention-sheet" tier="fast" className="w-full">
              <FileMentionPopover
                results={fileMention.results}
                loading={fileMention.loading}
                selectedIndex={fileMention.selectedIndex}
                query={fileMention.query}
                onSelect={fileMention.selectFile}
              />
            </Collapse>
          )}
        </AnimatePresence>

        <InputGroupTextarea
          value={draft}
          onChange={(e) => {
            composer.setDraft(e.target.value);
            fileMention.handleCursorChange(e);
          }}
          onPaste={handlePaste}
          // @ files and / skills read the Mac backend — web-direct has none, so
          // the hint would promise pickers that come back empty. A cloud chat's
          // `/` menu lists only what reaches a cloud turn: named when it has any.
          placeholder={
            placeholder ??
            (isCloudDirectWebMode()
              ? "Ask a follow-up…"
              : isClaudeAgent && (agentConfig.where !== "cloud" || cloudSlashItems.length > 0)
                ? "Ask a follow-up… (@ files, / skills)"
                : "Ask a follow-up… (@ files)")
          }
          disabled={sending}
          onKeyDown={handleKeyDown}
          onSelect={fileMention.handleCursorChange}
          onClick={fileMention.handleCursorChange}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="placeholder:text-placeholder max-h-48 min-h-12 overflow-y-auto px-4 py-3"
        />

        <InputGroupAddon
          align="block-end"
          className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pt-0 pb-2"
        >
          <div className="flex items-center gap-0.5">
            <ModelPicker
              model={model}
              lists={modelLists}
              thinkingLevel={shownThinking}
              thinkingLevels={modelThinkingLevels}
              hasMessages={hasMessages}
              onModelChange={(value) => composer.setModel(value, fittingLevels(value))}
              onThinkingLevelChange={composer.setThinkingLevel}
              onOpenNewTab={onOpenNewTab}
            />
            {showPlanMode && (
              <PlanModeToggle enabled={planModeEnabled} onClick={composer.togglePlanMode} />
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {showCompactButton && (
              <Button
                onClick={onCompact}
                disabled={sending}
                title="Compact conversation"
                variant="ghost"
                size="sm"
                className="text-warning border"
              >
                <Minimize2 className="size-3.5" />
                <span className="text-xs font-normal">Compact</span>
              </Button>
            )}

            <ContextTokenIndicator
              contextTokenCount={contextTokenCount}
              contextUsedPercent={contextUsedPercent}
              onCompact={onCompact}
            />

            {sessionStatus && ACTIVE_TURN_STATUSES.includes(sessionStatus) && (
              <InputGroupButton
                onClick={onStop}
                variant="default"
                size="icon-sm"
                title="Stop execution"
                aria-label="Stop execution"
                className="rounded-full"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </InputGroupButton>
            )}

            <InputGroupButton
              onClick={handleSend}
              disabled={!canSend}
              variant={hasContent ? "default" : "outline"}
              size="icon-sm"
              title={sendDisabledReason ?? "Send message (Enter)"}
              aria-label="Send message"
              className="rounded-full"
            >
              <ArrowUp className="h-4 w-4" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
