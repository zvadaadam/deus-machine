import type { SessionStatus } from "@/shared/types";
import { useState, forwardRef, useImperativeHandle } from "react";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2, ArrowUp, Square, Wrench } from "lucide-react";
import { useFileMention } from "../hooks/useFileMention";
import { useSlashCommand } from "../hooks/useSlashCommand";
import { useImageAttachments } from "../hooks/useImageAttachments";
import { FileMentionPopover } from "./FileMentionPopover";
import { SlashCommandPopover } from "./SlashCommandPopover";
import { GENERATE_HIVE_JSON } from "../lib/sessionPrompts";
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
import { InspectedElementCard, type InspectedElement } from "./InspectedElementCard";
import { FileMentionCard, type FileMention } from "./FileMentionCard";
import { SkillMentionCard, type SkillMention } from "./SkillMentionCard";
import { serializeInspectElement } from "../lib/parseInspectTags";
import {
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

interface PastedText {
  id: string;
  content: string;
}

export interface MessageInputRef {
  addFiles: (files: File[]) => Promise<void>;
  clearPastedContent: () => void;
  addInspectedElement: (element: Omit<InspectedElement, "id">) => void;
}

// Long pastes (20+ lines) are shown as collapsed cards instead of inline text
const PASTE_LINE_THRESHOLD = 20;

interface MessageInputProps {
  messageInput: string;
  sending: boolean;
  sessionStatus?: SessionStatus;
  model: string;
  thinkingLevel?: string;
  showCompactButton?: boolean;
  contextTokenCount?: number;
  contextUsedPercent?: number;
  /** Workspace path for @ file mention search */
  workspacePath?: string | null;
  /** Workspace ID for the file search HTTP endpoint */
  workspaceId?: string | null;
  /**
   * Whether the session already has messages.
   * Once a session has messages, its agent type (claude/codex) is locked —
   * the user can still switch models within the same agent type, but
   * switching to a different agent type requires opening a new chat tab.
   */
  hasMessages?: boolean;
  /** Whether a deus.json manifest exists for this workspace */
  hasManifest?: boolean;
  onMessageChange: (value: string) => void;
  onSend: (content?: string) => void;
  onCompact?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
  /** Called when user picks a model from a locked agent group (opens new tab) */
  onOpenNewTab?: (initialModel?: string) => void;
  onThinkingLevelChange?: (level: string) => void;
  planModeEnabled?: boolean;
  onPlanModeToggle?: () => void;
  planModeDisabled?: boolean;
  hasPendingPlan?: boolean;
  className?: string;
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(function MessageInput(
  {
    messageInput,
    sending,
    sessionStatus,
    model,
    thinkingLevel = "NONE",
    showCompactButton = false,
    contextTokenCount = 0,
    contextUsedPercent = 0,
    workspacePath = null,
    workspaceId = null,
    hasMessages = false,
    hasManifest = true,
    onMessageChange,
    onSend,
    onCompact,
    onStop,
    onModelChange,
    onOpenNewTab,
    onThinkingLevelChange,
    planModeEnabled = false,
    onPlanModeToggle,
    planModeDisabled = false,
    hasPendingPlan = false,
    className,
  },
  ref
) {
  const isMobile = useIsMobile();

  // Image attachments (shared hook with HomeView)
  const {
    attachments,
    processFiles,
    removeAttachment,
    clearAttachments,
    extractImagesFromClipboard,
    buildImageBlocks,
  } = useImageAttachments();

  // Pasted text cards (long pastes shown as collapsed cards)
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);

  // Inspected elements from InSpec mode (shown as pill cards)
  const [inspectedElements, setInspectedElements] = useState<InspectedElement[]>([]);

  // File mentions picked from the @ picker (shown as pill cards above textarea)
  const [fileMentions, setFileMentions] = useState<FileMention[]>([]);

  // Skill mentions picked from the / picker (orange pills, serialize as /<name>)
  const [skillMentions, setSkillMentions] = useState<SkillMention[]>([]);

  // Expose addFiles + clearPastedContent + addInspectedElement for parent-level interactions
  useImperativeHandle(
    ref,
    () => ({
      addFiles: processFiles,
      clearPastedContent: () => {
        setPastedTexts([]);
        clearAttachments();
        setInspectedElements([]);
        setFileMentions([]);
        setSkillMentions([]);
      },
      addInspectedElement: (element: Omit<InspectedElement, "id">) => {
        setInspectedElements((prev) => [...prev, { ...element, id: crypto.randomUUID() }]);
      },
    }),
    [processFiles, clearAttachments]
  );

  /**
   * Build combined content from pasted texts + inspected elements + typed input + images.
   * When images are present, returns a JSON-stringified content blocks array
   * (Anthropic API format). Otherwise returns plain text for backward compat.
   */
  const buildCombinedContent = () => {
    // Combine all text sources (inspected elements serialized as <inspect> XML tags)
    const textParts: string[] = [];

    // Skill mentions must come FIRST — Claude Code only parses slash commands
    // at position 0 of the message. Join with spaces on one line.
    if (skillMentions.length > 0) {
      textParts.push(skillMentions.map((s) => `/${s.name}`).join(" "));
    }

    // Inspected elements go first so the AI has element context before user's question
    for (const el of inspectedElements) {
      textParts.push(serializeInspectElement(el));
    }

    // File mentions serialize as `@path` tokens — Claude Code natively resolves them.
    // Joined on one line to read like a natural reference list.
    if (fileMentions.length > 0) {
      textParts.push(fileMentions.map((fm) => `@${fm.path}`).join(" "));
    }

    for (const paste of pastedTexts) {
      textParts.push(paste.content);
    }
    const typed = messageInput.trim();
    if (typed) {
      textParts.push(typed);
    }
    const combinedText = textParts.join("\n\n");

    // No images: return plain text string (backward compatible)
    const imageBlocks = buildImageBlocks();
    if (!imageBlocks) {
      return combinedText;
    }

    // With images: build Anthropic API content blocks array, JSON-stringified.
    const blocks: Array<Record<string, unknown>> = [];
    if (combinedText) {
      blocks.push({ type: "text", text: combinedText });
    }
    blocks.push(...imageBlocks);
    return JSON.stringify(blocks);
  };

  const hasContent =
    messageInput.trim().length > 0 ||
    pastedTexts.length > 0 ||
    attachments.length > 0 ||
    inspectedElements.length > 0 ||
    fileMentions.length > 0 ||
    skillMentions.length > 0;

  // Send with combined content (pasted texts + typed input + images)
  // Pasted content is NOT cleared here — it's cleared by the parent via
  // ref.clearPastedContent() inside onMessageSent (only on success), mirroring
  // how messageInput is cleared. This prevents data loss on send failure.
  const handleSend = () => {
    if (sending || !hasContent) return;
    const combined = buildCombinedContent();
    if (combined) {
      onSend(combined);
    }
  };

  // @ file mention support (fuzzy search via backend HTTP endpoint)
  // Selected files surface as pills above the textarea instead of inline text.
  const fileMention = useFileMention({
    value: messageInput,
    workspaceId: workspaceId ?? null,
    onChange: onMessageChange,
    onAddMention: (result) => {
      setFileMentions((prev) => [
        ...prev,
        { id: crypto.randomUUID(), path: result.path, name: result.name },
      ]);
    },
  });

  // / slash command support (skills + commands picker, Claude only).
  // Skills surface as orange pills; commands still insert `/name ` inline.
  const selectedOption = getModelOption(model);
  const agentHarness: AgentHarness = selectedOption?.agentHarness ?? getAgentHarnessForModel(model);
  const modelId = selectedOption?.model ?? model;
  const isClaudeAgent = agentHarness === "claude";
  const slashCommand = useSlashCommand({
    value: messageInput,
    workspacePath,
    onChange: onMessageChange,
    enabled: isClaudeAgent,
    onAddSkill: (skill) => {
      setSkillMentions((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name: skill.name, description: skill.description },
      ]);
    },
  });

  // Keyboard shortcut — popovers get first pass for arrow/enter/escape
  // Desktop: Enter sends, Shift+Enter inserts newline
  // Mobile: Enter inserts newline, send button sends (standard mobile UX)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let slash command popover handle navigation keys first
    if (slashCommand.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    // Then file mention popover
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
    // Check for pasted images first
    const imageFiles = extractImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      e.preventDefault();
      processFiles(imageFiles);
      return;
    }

    // Check for long text pastes (20+ lines shown as collapsed cards)
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;

    const lineCount = text.split("\n").length;
    if (lineCount >= PASTE_LINE_THRESHOLD) {
      e.preventDefault();
      setPastedTexts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          content: text,
        },
      ]);
    }
    // Under threshold: native paste into textarea
  };

  const removePastedText = (id: string) => {
    setPastedTexts((prev) => prev.filter((p) => p.id !== id));
  };

  const removeInspectedElement = (id: string) => {
    setInspectedElements((prev) => prev.filter((el) => el.id !== id));
  };

  const removeFileMention = (id: string) => {
    setFileMentions((prev) => prev.filter((fm) => fm.id !== id));
  };

  const removeSkillMention = (id: string) => {
    setSkillMentions((prev) => prev.filter((s) => s.id !== id));
  };

  // Thinking cycle — derive agent type from selected model
  const modelThinkingLevels = getThinkingLevelsForModel(agentHarness, modelId);
  const showThinkingIndicator = modelThinkingLevels.length > 0;

  const handleCycleThinking = () => {
    const next = cycleThinkingLevel(thinkingLevel as ThinkingLevel, agentHarness, modelId);
    onThinkingLevelChange?.(next);
  };

  // Show "Set up your environment" nudge when no manifest and no messages yet
  const showSetupNudge = !hasManifest && !hasMessages;

  const handleSetupEnvironment = () => onSend(GENERATE_HIVE_JSON);

  return (
    <div className={cn("relative z-20 shrink-0 px-2 pb-2", className)}>
      {/* Environment setup nudge — visible when no deus.json and chat is empty */}
      <AnimatePresence>
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
              className="text-text-muted hover:text-text-secondary border-border-subtle hover:border-border hover:bg-bg-muted flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 text-xs transition-colors duration-200"
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
        className="bg-input-surface relative overflow-visible rounded-2xl border-0 shadow-xs transition-colors duration-200"
      >
        {/* Pasted content cards (images + text + inspects + file/skill mentions) — unified horizontal scroll */}
        {(attachments.length > 0 ||
          pastedTexts.length > 0 ||
          inspectedElements.length > 0 ||
          fileMentions.length > 0 ||
          skillMentions.length > 0) && (
          <div className="flex w-full items-start gap-2 overflow-x-auto px-3 pt-3">
            <AnimatePresence mode="popLayout">
              {skillMentions.map((s) => (
                <SkillMentionCard
                  key={s.id}
                  mention={s}
                  onRemove={() => removeSkillMention(s.id)}
                />
              ))}
              {inspectedElements.map((el) => (
                <InspectedElementCard
                  key={el.id}
                  element={el}
                  onRemove={() => removeInspectedElement(el.id)}
                />
              ))}
              {fileMentions.map((fm) => (
                <FileMentionCard
                  key={fm.id}
                  mention={fm}
                  onRemove={() => removeFileMention(fm.id)}
                />
              ))}
              {attachments.map((attachment) => (
                <PastedImageCard
                  key={attachment.id}
                  preview={attachment.preview}
                  fileName={attachment.file.name}
                  onRemove={() => removeAttachment(attachment.id)}
                />
              ))}
              {pastedTexts.map((paste) => (
                <PastedTextCard
                  key={paste.id}
                  content={paste.content}
                  onRemove={() => removePastedText(paste.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Slash command sheet — slides out above textarea */}
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

        {/* File mention sheet — slides out above textarea */}
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

        {/* Textarea */}
        <InputGroupTextarea
          value={messageInput}
          onChange={(e) => {
            onMessageChange(e.target.value);
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

        {/* Bottom toolbar */}
        <InputGroupAddon
          align="block-end"
          className="flex w-full items-center justify-between px-2"
        >
          {/* Controls group (left) */}
          <div className="flex items-center gap-0.5">
            <ModelPicker
              model={model}
              hasMessages={hasMessages}
              onModelChange={onModelChange}
              onOpenNewTab={onOpenNewTab}
            />

            {/* Thinking effort — text label cycles through model-specific levels.
                Hidden for models that don't support thinking (e.g. Haiku). */}
            {showThinkingIndicator && (
              <ThinkingIndicator
                level={thinkingLevel as ThinkingLevel}
                onClick={handleCycleThinking}
              />
            )}
            {onPlanModeToggle && (
              <PlanModeToggle
                enabled={planModeEnabled}
                onClick={onPlanModeToggle}
                disabled={planModeDisabled}
              />
            )}
          </div>

          {/* Actions group (right) */}
          <div className="flex items-center gap-1">
            {/* Compact button - shown when enough messages to benefit */}
            {showCompactButton && (
              <Button
                onClick={onCompact}
                disabled={sending}
                title="Compact conversation"
                variant="ghost"
                size="sm"
                className="text-warning rounded-lg border"
              >
                <Minimize2 className="size-3.5" />
                <span className="text-xs font-normal">Compact</span>
              </Button>
            )}

            {/* Context window indicator — also acts as compact button when > 80% */}
            <ContextTokenIndicator
              contextTokenCount={contextTokenCount}
              contextUsedPercent={contextUsedPercent}
              onCompact={onCompact}
            />

            {/* Stop button - hidden when plan approval is pending (agent is blocked, not working) */}
            {sessionStatus === "working" && !hasPendingPlan && (
              <InputGroupButton
                onClick={onStop}
                variant="default"
                size="icon-sm"
                title="Stop execution"
                className="bg-foreground text-background hover:bg-foreground/90 rounded-full"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </InputGroupButton>
            )}

            {/* Send button - always visible, highlighted when content exists */}
            <InputGroupButton
              onClick={handleSend}
              disabled={sending || !hasContent}
              variant={hasContent ? "default" : "outline"}
              size="icon-sm"
              title="Send message (Enter)"
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
});
