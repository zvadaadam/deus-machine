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
 * The only thing the parent still owns is the *send path*: we call
 * `onSend(combinedContent)` and the parent (SessionComposer) wires it
 * into the session mutation + clears store content on success.
 */

import type { SessionStatus } from "@/shared/types";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2, ArrowUp, Square, Wrench } from "lucide-react";
import { useFileMention } from "../hooks/useFileMention";
import { useSlashCommand } from "../hooks/useSlashCommand";
import { useSessionComposer } from "../hooks/useSessionComposer";
import { FileMentionPopover } from "./FileMentionPopover";
import { SlashCommandPopover } from "./SlashCommandPopover";
import { GENERATE_HIVE_JSON } from "../lib/sessionPrompts";
import {
  extractImagesFromClipboard,
  processImageFiles,
  buildImageBlocks,
} from "../lib/imageAttachments";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { PastedTextCard } from "./PastedTextCard";
import { PastedImageCard } from "./PastedImageCard";
import { InspectedElementCard } from "./InspectedElementCard";
import { FileMentionCard } from "./FileMentionCard";
import { SkillMentionCard } from "./SkillMentionCard";
import { serializeInspectElement } from "../lib/parseInspectTags";
import {
  DEFAULT_MODEL,
  getAgentHarnessForModel,
  getModelOption,
  cycleThinkingLevel,
  getThinkingLevelsForModel,
  type AgentHarness,
  type ThinkingLevel,
} from "@/shared/agents";
import { ThinkingIndicator } from "./ThinkingIndicator";
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
  /** Seed initial model on first mount if the store doesn't have this
   *  session yet. Ignored afterwards. */
  initialModel?: string;

  sending: boolean;
  sessionStatus?: SessionStatus;
  contextTokenCount?: number;
  contextUsedPercent?: number;
  /** Whether the session already has messages (gates model-switch behaviour). */
  hasMessages?: boolean;
  /** Whether a deus.json manifest exists for this workspace. */
  hasManifest?: boolean;
  showCompactButton?: boolean;
  hasPendingPlan?: boolean;

  onSend: (content: string) => void;
  onCompact?: () => void;
  onStop?: () => void;
  onOpenNewTab?: (initialModel?: string) => void;

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
  initialModel,
  sending,
  sessionStatus,
  contextTokenCount = 0,
  contextUsedPercent = 0,
  hasMessages = false,
  hasManifest = true,
  showCompactButton = false,
  hasPendingPlan = false,
  onSend,
  onCompact,
  onStop,
  onOpenNewTab,
  defaultThinking = "HIGH",
  className,
}: MessageInputProps) {
  const isMobile = useIsMobile();

  // Composer content — subscribed from the store, mutated via bound setters.
  const composer = useSessionComposer(sessionId, {
    initialModel: initialModel ?? DEFAULT_MODEL,
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

  const selectedOption = getModelOption(model);
  const agentHarness: AgentHarness = selectedOption?.agentHarness ?? getAgentHarnessForModel(model);
  const modelId = selectedOption?.model ?? model;
  const isClaudeAgent = agentHarness === "claude";

  // Build combined message content from all staged sources.
  // See the big block-comment in the previous revision for ordering rationale
  // (skills first → inspected elements → file mentions → pastes → typed text,
  // then images appended as Anthropic content blocks).
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

    const imageBlocks = buildImageBlocks(imageAttachments);
    if (!imageBlocks) return combinedText;

    const blocks: Array<Record<string, unknown>> = [];
    if (combinedText) blocks.push({ type: "text", text: combinedText });
    blocks.push(...imageBlocks);
    return JSON.stringify(blocks);
  };

  const hasContent =
    draft.trim().length > 0 ||
    pastedTexts.length > 0 ||
    imageAttachments.length > 0 ||
    inspectedElements.length > 0 ||
    fileMentions.length > 0 ||
    skillMentions.length > 0;

  const handleSend = () => {
    if (sending || !hasContent) return;
    const combined = buildCombinedContent();
    if (combined) onSend(combined);
    // Parent clears store content on successful send (see SessionComposer
    // onMessageSent → composer.clearContent).
  };

  // @ file mention popover — local UI-ephemeral state (open/close, query,
  // selected index). Picked files get pushed into the composer store.
  const fileMention = useFileMention({
    value: draft,
    workspaceId: workspaceId ?? null,
    onChange: composer.setDraft,
    onAddMention: (result) => composer.addFileMention({ path: result.path, name: result.name }),
  });

  // / slash command popover — same pattern. Picked skills → store.
  const slashCommand = useSlashCommand({
    value: draft,
    workspacePath,
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
      const processed = await processImageFiles(imageFiles);
      if (processed.length) composer.addImageAttachments(processed);
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

  // Thinking cycle — derive supported levels from the selected model.
  const modelThinkingLevels = getThinkingLevelsForModel(agentHarness, modelId);
  const showThinkingIndicator = modelThinkingLevels.length > 0;

  const handleCycleThinking = () => {
    const next = cycleThinkingLevel(thinkingLevel, agentHarness, modelId);
    composer.setThinkingLevel(next);
  };

  // "Set up your environment" nudge — visible when no deus.json + no history yet.
  const showSetupNudge = !hasManifest && !hasMessages;
  const handleSetupEnvironment = () => onSend(GENERATE_HIVE_JSON);

  const planModeDisabled = agentHarness === "codex";
  return (
    <div className={cn("relative z-20 shrink-0 px-2 pb-2", className)}>
      <AnimatePresence initial={false}>
        {showSetupNudge && (
          <motion.div
            key="setup-nudge"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }}
            className="mb-2 flex"
          >
            <button
              type="button"
              onClick={handleSetupEnvironment}
              className="text-text-muted hover:text-text-secondary border-border-subtle hover:border-border hover:bg-bg-muted flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 text-xs transition-[color,background-color,border-color,scale] duration-200 active:scale-[0.97]"
            >
              <Wrench className="h-3 w-3 shrink-0" />
              <span>Set up your environment</span>
              <span className="text-text-disabled">&rarr;</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <InputGroup
        data-no-ring={true}
        // Unified glass pill: translucent raised bg + backdrop blur + hairline
        // ring + shadow. Reads as an elevated surface against the chat panel
        // (which is ~#f5f5f4) and as a floating glass pill against a webpage
        // in focus mode. Same styling in both contexts — no branching.
        className="bg-bg-muted/75 ring-border-subtle relative overflow-visible rounded-2xl border-0 shadow-lg ring-1 backdrop-blur-xl"
      >
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
            <motion.div
              key="slash-command-sheet"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
              className="w-full overflow-hidden"
            >
              <SlashCommandPopover
                results={slashCommand.results}
                loading={slashCommand.loading}
                selectedIndex={slashCommand.selectedIndex}
                query={slashCommand.query}
                onSelect={slashCommand.selectItem}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {fileMention.isOpen && (
            <motion.div
              key="file-mention-sheet"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
              className="w-full overflow-hidden"
            >
              <FileMentionPopover
                results={fileMention.results}
                loading={fileMention.loading}
                selectedIndex={fileMention.selectedIndex}
                query={fileMention.query}
                onSelect={fileMention.selectFile}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <InputGroupTextarea
          value={draft}
          onChange={(e) => {
            composer.setDraft(e.target.value);
            fileMention.handleCursorChange(e);
          }}
          onPaste={handlePaste}
          placeholder="Ask a follow-up ... (@ files, / skills)"
          disabled={sending}
          onKeyDown={handleKeyDown}
          onSelect={fileMention.handleCursorChange}
          onClick={fileMention.handleCursorChange}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            "placeholder:text-placeholder max-h-48 min-h-10 overflow-y-auto pt-4 pl-4",
            className
          )}
        />

        <InputGroupAddon
          align="block-end"
          className="flex w-full items-center justify-between px-2"
        >
          <div className="flex items-center gap-0.5">
            <ModelPicker
              model={model}
              hasMessages={hasMessages}
              onModelChange={composer.setModel}
              onOpenNewTab={onOpenNewTab}
            />

            {showThinkingIndicator && (
              <ThinkingIndicator level={thinkingLevel} onClick={handleCycleThinking} />
            )}
            <PlanModeToggle
              enabled={planModeEnabled}
              onClick={composer.togglePlanMode}
              disabled={planModeDisabled}
            />
          </div>

          <div className="flex items-center gap-1">
            {showCompactButton && (
              <Button
                onClick={onCompact}
                disabled={sending}
                title="Compact conversation"
                variant="ghost"
                size="sm"
                className="text-warning rounded-lg border active:not-disabled:scale-[0.97]"
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

            {sessionStatus === "working" && !hasPendingPlan && (
              <InputGroupButton
                onClick={onStop}
                variant="default"
                size="icon-sm"
                title="Stop execution"
                className="bg-foreground text-background hover:bg-foreground/90 rounded-full transition-[background-color,scale] duration-150 active:scale-[0.97]"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </InputGroupButton>
            )}

            <InputGroupButton
              onClick={handleSend}
              disabled={sending || !hasContent}
              variant={hasContent ? "default" : "outline"}
              size="icon-sm"
              title="Send message (Enter)"
              aria-label="Send message"
              className="rounded-full transition-[background-color,color,scale] duration-150 active:not-disabled:scale-[0.97]"
            >
              <ArrowUp className="h-4 w-4" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
