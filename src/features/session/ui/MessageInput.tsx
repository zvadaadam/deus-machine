import type { SessionStatus } from "@/shared/types";
import { useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Minimize2,
  ArrowUp,
  Square,
  Plus,
  Globe,
  ChevronDown,
  Check,
  ArrowUpRight,
  Wrench,
} from "lucide-react";
import { useFileMention } from "../hooks/useFileMention";
import { FileMentionPopover } from "./FileMentionPopover";
import { GENERATE_HIVE_JSON } from "../lib/sessionPrompts";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import { PastedTextCard } from "./PastedTextCard";
import { PastedImageCard } from "./PastedImageCard";
import { InspectedElementCard, type InspectedElement } from "./InspectedElementCard";
import { serializeInspectElement } from "../lib/parseInspectTags";
import {
  getRuntimeModelLabel,
  getRuntimeModelOption,
  RUNTIME_MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  cycleThinkingLevel,
  type RuntimeAgentType,
  type ThinkingLevel,
} from "../lib/agentRuntime";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface Attachment {
  id: string;
  file: File;
  preview: string;
  type: string;
}

interface PastedText {
  id: string;
  content: string;
}

export interface MessageInputRef {
  addFiles: (files: File[]) => Promise<void>;
  clearPastedContent: () => void;
  addInspectedElement: (element: Omit<InspectedElement, "id">) => void;
}

// Anthropic API only supports these image formats for vision
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface MessageInputProps {
  messageInput: string;
  sending: boolean;
  sessionStatus?: SessionStatus;
  embedded?: boolean;
  model?: string;
  thinkingLevel?: string;
  showCompactButton?: boolean;
  contextTokenCount?: number;
  /** Workspace path for @ file mention search */
  workspacePath?: string | null;
  /**
   * Whether the session already has messages.
   * Once a session has messages, its agent type (claude/codex) is locked —
   * the user can still switch models within the same agent type, but
   * switching to a different agent type requires opening a new chat tab.
   */
  hasMessages?: boolean;
  /** Whether a opendevs.json manifest exists for this workspace */
  hasManifest?: boolean;
  onMessageChange: (value: string) => void;
  onSend: (content?: string) => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
  /** Called when user picks a model from a locked agent group (opens new tab) */
  onOpenNewTab?: (initialModel?: string) => void;
  onThinkingLevelChange?: (level: string) => void;
  onAttachmentClick?: () => void;
  className?: string;
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(function MessageInput(
  {
    messageInput,
    sending,
    sessionStatus,
    embedded: _embedded = false,
    model = "opus",
    thinkingLevel = "NONE",
    showCompactButton = false,
    contextTokenCount = 0,
    workspacePath = null,
    hasMessages = false,
    hasManifest = true,
    onMessageChange,
    onSend,
    onCompact,
    onCreatePR: _onCreatePR,
    onStop,
    onModelChange,
    onOpenNewTab,
    onThinkingLevelChange,
    onAttachmentClick,
    className,
  },
  ref
) {
  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Pasted text cards (long pastes shown as collapsed cards)
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);

  // Inspected elements from InSpec mode (shown as pill cards)
  const [inspectedElements, setInspectedElements] = useState<InspectedElement[]>([]);

  // Browser MCP state (future integration)
  const [browserEnabled, setBrowserEnabled] = useState(false);

  // Process image files into attachment previews (shared by paste + panel drop)
  const processFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
    if (!imageFiles.length) return;
    const previews = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<Attachment | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = (ev) =>
              resolve({
                id: crypto.randomUUID(),
                file,
                preview: ev.target?.result as string,
                type: file.type,
              });
            reader.onerror = () => resolve(null);
            reader.onabort = () => resolve(null);
            reader.readAsDataURL(file);
          })
      )
    );
    const valid = previews.filter(Boolean) as Attachment[];
    if (valid.length) setAttachments((prev) => [...prev, ...valid]);
  }, []);

  // Expose addFiles + clearPastedContent + addInspectedElement for parent-level interactions
  useImperativeHandle(
    ref,
    () => ({
      addFiles: processFiles,
      clearPastedContent: () => {
        setPastedTexts([]);
        setAttachments([]);
        setInspectedElements([]);
      },
      addInspectedElement: (element: Omit<InspectedElement, "id">) => {
        setInspectedElements((prev) => [...prev, { ...element, id: crypto.randomUUID() }]);
      },
    }),
    [processFiles]
  );

  /**
   * Build combined content from pasted texts + inspected elements + typed input + images.
   * When images are present, returns a JSON-stringified content blocks array
   * (Anthropic API format). Otherwise returns plain text for backward compat.
   */
  const buildCombinedContent = () => {
    const hasImages = attachments.length > 0;

    // Combine all text sources (inspected elements serialized as <inspect> XML tags)
    const textParts: string[] = [];

    // Inspected elements go first so the AI has element context before user's question
    for (const el of inspectedElements) {
      textParts.push(serializeInspectElement(el));
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
    if (!hasImages) {
      return combinedText;
    }

    // With images: build Anthropic API content blocks array, JSON-stringified.
    // The sidecar parses this and passes the array as MessageParam.content to the SDK.
    const blocks: Array<Record<string, unknown>> = [];

    if (combinedText) {
      blocks.push({ type: "text", text: combinedText });
    }

    for (const attachment of attachments) {
      // Strip data URL prefix (e.g. "data:image/png;base64,") to get raw base64
      const base64Data = attachment.preview.includes(",")
        ? attachment.preview.split(",")[1]
        : attachment.preview;

      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.type,
          data: base64Data,
        },
      });
    }

    return JSON.stringify(blocks);
  };

  const hasContent =
    messageInput.trim().length > 0 ||
    pastedTexts.length > 0 ||
    attachments.length > 0 ||
    inspectedElements.length > 0;

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

  // @ file mention support (nucleo-powered fuzzy search via Rust)
  const fileMention = useFileMention({
    value: messageInput,
    workspacePath: workspacePath ?? null,
    onChange: onMessageChange,
  });

  // Keyboard shortcut — file mention gets first pass for arrow/enter/escape
  // Enter sends, Shift+Enter inserts newline (standard chat UX)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let file mention popover handle navigation keys first
    if (fileMention.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }

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
  };

  // Intercept long pastes (20+ lines) → show as collapsed card
  const PASTE_LINE_THRESHOLD = 20;

  const handlePaste = async (e: React.ClipboardEvent) => {
    // Check for pasted images — clipboardData.items is the reliable API
    // (clipboardData.files is often empty for clipboard screenshots)
    const imageFiles: File[] = [];
    if (e.clipboardData.items) {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      processFiles(imageFiles);
      return;
    }

    // Check for long text pastes
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

  const modelLabel = getRuntimeModelLabel(model);
  const selectedOption = getRuntimeModelOption(model);
  const selectedOptionValue = selectedOption?.value;
  // Agent group of the currently selected model (claude or codex)
  const currentGroup = selectedOption?.group ?? "claude";

  /** Thinking cycle — per-agent levels defined in agentRuntime's AgentConfig.
   *  Claude: LOW ↔ HIGH   Codex: LOW → MEDIUM → HIGH → LOW */
  const agentType: RuntimeAgentType = selectedOption?.agentType ?? "claude";

  const handleCycleThinking = () => {
    const next = cycleThinkingLevel(thinkingLevel as ThinkingLevel, agentType);
    onThinkingLevelChange?.(next);
  };

  // Context window calculation (200k token limit for Sonnet 3.5)
  const MAX_TOKENS = 200000;
  const contextPercentage = Math.min((contextTokenCount / MAX_TOKENS) * 100, 100);
  // Use CSS variables instead of hardcoded hex values (CLAUDE.md compliance)
  const contextFillColor =
    contextPercentage > 80
      ? "var(--primary)" // Copper/warning when > 80%
      : "var(--muted-foreground)"; // Neutral gray normally

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const renderAgentIcon = (type: RuntimeAgentType, size: "sm" | "md" = "md") => {
    const LogoComponent = getAgentLogo(type);
    const sizeClass = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
    if (!LogoComponent) {
      return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", sizeClass)} />;
    }

    return <LogoComponent className={cn("flex-shrink-0", sizeClass)} />;
  };

  // Show "Set up your environment" nudge when no manifest and no messages yet
  const showSetupNudge = !hasManifest && !hasMessages;

  const handleSetupEnvironment = () => onSend(GENERATE_HIVE_JSON);

  return (
    <div className={cn("relative z-20 shrink-0 px-4 pb-4", className)}>
      {/* Environment setup nudge — visible when no opendevs.json and chat is empty */}
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

      {/* File mention popover — anchored above the input group */}
      <AnimatePresence>
        {fileMention.isOpen && (
          <motion.div
            key="file-mention-popover"
            initial={{ opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 4 }}
            transition={{ duration: 0.15, ease: [0.215, 0.61, 0.355, 1] }}
            className="absolute right-4 bottom-full left-4 z-50 mb-2 flex justify-start"
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
      <InputGroup
        data-no-ring={true}
        className="bg-input-surface relative overflow-visible rounded-2xl border-0 shadow-xs transition-colors duration-200"
      >
        {/* Pasted content cards (images + text + inspected elements) — unified horizontal scroll */}
        {(attachments.length > 0 || pastedTexts.length > 0 || inspectedElements.length > 0) && (
          <div className="scrollbar-vibrancy flex w-full items-start gap-2 overflow-x-auto px-3 pt-3">
            <AnimatePresence mode="popLayout">
              {inspectedElements.map((el) => (
                <InspectedElementCard
                  key={el.id}
                  element={el}
                  onRemove={() => removeInspectedElement(el.id)}
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

        {/* Textarea */}
        <InputGroupTextarea
          value={messageInput}
          onChange={(e) => {
            onMessageChange(e.target.value);
            fileMention.handleCursorChange(e);
          }}
          onPaste={handlePaste}
          placeholder="Ask a follow-up ... (type @ to mention a file)"
          disabled={sending}
          onKeyDown={handleKeyDown}
          onSelect={fileMention.handleCursorChange}
          onClick={fileMention.handleCursorChange}
          className={cn(
            "scrollbar-vibrancy placeholder:text-placeholder max-h-48 min-h-10 overflow-y-auto pt-4 pl-4",
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
            {/* Add attachment button */}
            <InputGroupButton
              onClick={onAttachmentClick}
              variant="ghost"
              size="icon-sm"
              title="Add attachment"
              className="rounded-lg"
            >
              <Plus className="h-3.5 w-3.5" />
            </InputGroupButton>

            {/* Model picker dropdown — shows agent icon + model label */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Select model"
                  aria-label={`Select model, currently ${modelLabel}`}
                  className="group gap-1.5 rounded-lg focus-visible:ring-0"
                >
                  {renderAgentIcon(selectedOption?.agentType ?? "claude", "sm")}
                  <span className="text-text-muted text-xs font-medium">{modelLabel}</span>
                  <ChevronDown className="text-text-disabled size-3 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className={cn(
                  "border-border/55 w-60 rounded-xl border p-1.5",
                  "from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                  "shadow-[var(--shadow-elevated)]"
                )}
              >
                {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => {
                  /**
                   * Agent type lock: once a session has messages, its agent harness
                   * (claude/codex) is fixed. The user can switch models within the
                   * same harness, but switching harnesses requires a new chat tab.
                   * This is a DB-level constraint: sessions.agent_type is set on
                   * first message and the sidecar binds to that harness for the
                   * session's lifetime.
                   */
                  const isLockedGroup = hasMessages && agentConfig.id !== currentGroup;

                  return (
                    <div key={agentConfig.id}>
                      {groupIdx > 0 && <DropdownMenuSeparator className="bg-border/70 my-1.5" />}
                      <DropdownMenuLabel>
                        <span className="text-text-muted/90 text-2xs px-1 font-normal tracking-wide">
                          {agentConfig.groupLabel}
                        </span>
                      </DropdownMenuLabel>
                      {RUNTIME_MODEL_OPTIONS.filter((o) => o.group === agentConfig.id).map(
                        (option) => {
                          const isSelected = selectedOptionValue === option.value;
                          return (
                            <DropdownMenuItem
                              key={option.value}
                              onClick={() =>
                                isLockedGroup
                                  ? onOpenNewTab?.(option.value)
                                  : onModelChange?.(option.value)
                              }
                              className={cn(
                                "text-text-secondary focus:bg-bg-raised/45 focus:text-text-primary",
                                "data-[highlighted]:bg-bg-raised/45 data-[highlighted]:text-text-primary",
                                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
                              )}
                            >
                              {renderAgentIcon(option.agentType)}
                              <span className="font-normal">{option.label}</span>
                              {option.isNew && (
                                <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted text-2xs rounded-xs border px-1 py-px tracking-wide uppercase">
                                  New
                                </span>
                              )}
                              <span className="ml-auto flex items-center">
                                {isSelected ? (
                                  <Check className="text-text-primary h-3 w-3" />
                                ) : isLockedGroup ? (
                                  <ArrowUpRight className="text-text-muted/60 h-3 w-3" />
                                ) : null}
                              </span>
                            </DropdownMenuItem>
                          );
                        }
                      )}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Thinking effort — text label cycles through agent-specific levels */}
            <ThinkingIndicator
              level={thinkingLevel as ThinkingLevel}
              onClick={handleCycleThinking}
            />
          </div>

          {/* Actions group (right) */}
          <div className="flex items-center gap-1">
            {/* Compact button - leftmost position */}
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

            {/* Context window indicator - circular progress */}
            <div
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              title={`Context: ${contextTokenCount.toLocaleString()} / ${MAX_TOKENS.toLocaleString()} tokens (${contextPercentage.toFixed(1)}%)`}
            >
              <svg className="h-3.5 w-3.5 -rotate-90" viewBox="0 0 16 16">
                {/* Background circle */}
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="transparent"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/30"
                />
                {/* Progress circle */}
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="transparent"
                  stroke={contextFillColor}
                  strokeWidth="2"
                  strokeDasharray={`${(contextPercentage / 100) * 37.7} 37.7`}
                  strokeLinecap="round"
                  className="transition-[stroke-dasharray] duration-300"
                />
              </svg>
              {/* Token count text - only show if > 0 */}
              {contextTokenCount > 0 && (
                <span className="text-2xs text-muted-foreground absolute font-medium">
                  {contextTokenCount >= 1000
                    ? `${(contextTokenCount / 1000).toFixed(0)}k`
                    : contextTokenCount}
                </span>
              )}
            </div>

            {/* Browser MCP toggle */}
            <InputGroupButton
              variant="ghost"
              size="icon-sm"
              onClick={() => setBrowserEnabled(!browserEnabled)}
              title={browserEnabled ? "Browser enabled" : "Enable browser"}
              aria-label={browserEnabled ? "Browser enabled" : "Enable browser"}
              className={cn("rounded-lg", browserEnabled ? "text-info" : "text-muted-foreground")}
            >
              <Globe className="h-3.5 w-3.5" />
            </InputGroupButton>

            {/* Stop button - shows when session is working */}
            {sessionStatus === "working" && (
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
