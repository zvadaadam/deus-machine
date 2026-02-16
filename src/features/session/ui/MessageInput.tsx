import type { SessionStatus } from "@/shared/types";
import { useState, forwardRef, useImperativeHandle } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Minimize2,
  ArrowUp,
  Square,
  Brain,
  Plus,
  Hammer,
  Globe,
  ChevronDown,
  Check,
  ArrowUpRight,
} from "lucide-react";
import { useFileMention } from "../hooks/useFileMention";
import { FileMentionPopover } from "./FileMentionPopover";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import { PastedTextCard } from "./PastedTextCard";
import { PastedImageCard } from "./PastedImageCard";
import {
  getRuntimeModelLabel,
  getRuntimeModelOption,
  RUNTIME_MODEL_OPTIONS,
  type RuntimeAgentType,
} from "../lib/agentRuntime";

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

interface MCPServer {
  name: string;
  active: boolean;
  command: string;
}

export interface MessageInputRef {
  addFiles: (files: File[]) => Promise<void>;
  clearPastedContent: () => void;
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
  mcpServers?: MCPServer[];
  contextTokenCount?: number;
  /** Workspace path for @ file mention search */
  workspacePath?: string | null;
  onMessageChange: (value: string) => void;
  onSend: (content?: string) => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
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
    model = "sonnet",
    thinkingLevel = "NONE",
    showCompactButton = false,
    mcpServers = [],
    contextTokenCount = 0,
    workspacePath = null,
    onMessageChange,
    onSend,
    onCompact,
    onCreatePR: _onCreatePR,
    onStop,
    onModelChange,
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

  // Browser MCP state (future integration)
  const [browserEnabled, setBrowserEnabled] = useState(false);

  // Process image files into attachment previews (shared by paste + panel drop)
  const processFiles = async (files: File[]) => {
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
  };

  // Expose addFiles + clearPastedContent for parent-level drag & drop and success cleanup
  useImperativeHandle(
    ref,
    () => ({
      addFiles: processFiles,
      clearPastedContent: () => {
        setPastedTexts([]);
        setAttachments([]);
      },
    }),
    []
  );

  /**
   * Build combined content from pasted texts + typed input + images.
   * When images are present, returns a JSON-stringified content blocks array
   * (Anthropic API format). Otherwise returns plain text for backward compat.
   */
  const buildCombinedContent = () => {
    const hasImages = attachments.length > 0;

    // Combine all text sources
    const textParts: string[] = [];
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
    messageInput.trim().length > 0 || pastedTexts.length > 0 || attachments.length > 0;

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
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let file mention popover handle navigation keys first
    if (fileMention.handleKeyDown(e as unknown as React.KeyboardEvent<HTMLTextAreaElement>)) {
      e.preventDefault();
      return;
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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

  const modelLabel = getRuntimeModelLabel(model);
  const selectedOptionValue = getRuntimeModelOption(model)?.value;

  // Thinking level - cycle through levels
  const cycleThinkingLevel = () => {
    const levels = ["NONE", "LOW", "MEDIUM", "HIGH"];
    const currentIndex = levels.indexOf(thinkingLevel);
    const nextLevel = levels[(currentIndex + 1) % levels.length];
    onThinkingLevelChange?.(nextLevel);
  };

  // Thinking dot indicators - always show 3 dots, fill based on level
  const renderThinkingDots = () => {
    if (thinkingLevel === "NONE") return null;

    const filledCount = thinkingLevel === "HIGH" ? 3 : thinkingLevel === "MEDIUM" ? 2 : 1;

    return (
      <div className="ml-0.5 flex flex-col gap-0.5">
        {[2, 1, 0].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 w-1 transition-all duration-200",
              i < filledCount ? "bg-primary" : "border-primary/40 border"
            )}
          />
        ))}
      </div>
    );
  };

  // MCP active count
  const activeMCPCount = mcpServers.filter((s) => s.active).length;

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

  const renderAgentIcon = (type: RuntimeAgentType) => {
    const LogoComponent = getAgentLogo(type);
    if (!LogoComponent) {
      return <span className="bg-muted-foreground/80 inline-flex h-3.5 w-3.5 rounded-full" />;
    }

    return <LogoComponent className="h-4 w-4 flex-shrink-0" />;
  };

  return (
    <div className={cn("relative z-20 shrink-0 px-4 pb-4", className)}>
      {/* File mention popover — anchored above the input group */}
      {fileMention.isOpen && (
        <div className="absolute right-4 bottom-full left-4 z-50 mb-2 flex justify-start">
          <FileMentionPopover
            results={fileMention.results}
            loading={fileMention.loading}
            selectedIndex={fileMention.selectedIndex}
            query={fileMention.query}
            onSelect={fileMention.selectFile}
          />
        </div>
      )}
      <InputGroup
        data-no-ring={true}
        className="bg-input-surface relative overflow-visible rounded-2xl border-0 shadow-xs transition-colors duration-200"
      >
        {/* Pasted content cards (images + text) — unified horizontal scroll */}
        {(attachments.length > 0 || pastedTexts.length > 0) && (
          <div className="scrollbar-vibrancy flex w-full items-start gap-2 overflow-x-auto px-3 pt-3">
            <AnimatePresence mode="popLayout">
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
          className="flex w-full items-center justify-between px-1.5"
        >
          {/* Controls group (left) */}
          <div className="flex items-center">
            {/* Add attachment button */}
            <InputGroupButton
              onClick={onAttachmentClick}
              variant="ghost"
              size="icon-sm"
              title="Add attachment"
              className="rounded-md"
            >
              <Plus className="h-4 w-4" />
            </InputGroupButton>

            {/* Model picker dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Select model"
                  aria-label={`Select model, currently ${modelLabel}`}
                  className="group rounded-md focus-visible:ring-0"
                >
                  <span className="text-text-muted text-xs font-normal">{modelLabel}</span>
                  <ChevronDown className="text-text-disabled size-3 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className={cn(
                  "border-border/55 w-[320px] rounded-[18px] border p-2",
                  "from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
                  "shadow-[var(--shadow-elevated)]"
                )}
              >
                <DropdownMenuLabel>
                  <span className="text-text-muted/90 px-1.5 text-[11px] font-normal tracking-[0.01em]">
                    Claude Code
                  </span>
                </DropdownMenuLabel>
                {RUNTIME_MODEL_OPTIONS.filter((option) => option.group === "claude").map(
                  (option) => {
                    const isSelected = selectedOptionValue === option.value;
                    return (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => onModelChange?.(option.value)}
                        className={cn(
                          "text-text-secondary focus:bg-bg-raised/45 focus:text-text-primary",
                          "data-[highlighted]:bg-bg-raised/45 data-[highlighted]:text-text-primary",
                          "flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-[14px]"
                        )}
                      >
                        {renderAgentIcon(option.agentType)}
                        <span className="font-normal">{option.label}</span>
                        {option.isNew && (
                          <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted rounded-[4px] border px-1.5 py-0.5 text-[10px] tracking-[0.08em] uppercase">
                            New
                          </span>
                        )}
                        {isSelected ? (
                          <Check className="text-text-primary ml-auto h-3.5 w-3.5" />
                        ) : (
                          <ArrowUpRight className="text-text-muted/65 ml-auto h-3.5 w-3.5" />
                        )}
                      </DropdownMenuItem>
                    );
                  }
                )}

                <DropdownMenuSeparator className="bg-border/70 my-2" />

                <DropdownMenuLabel>
                  <span className="text-text-muted/90 px-1.5 text-[11px] font-normal tracking-[0.01em]">
                    Codex
                  </span>
                </DropdownMenuLabel>
                {RUNTIME_MODEL_OPTIONS.filter((option) => option.group === "codex").map(
                  (option) => {
                    const isSelected = selectedOptionValue === option.value;
                    return (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => onModelChange?.(option.value)}
                        className={cn(
                          "text-text-secondary focus:bg-bg-raised/45 focus:text-text-primary",
                          "data-[highlighted]:bg-bg-raised/45 data-[highlighted]:text-text-primary",
                          "flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-[14px]"
                        )}
                      >
                        {renderAgentIcon(option.agentType)}
                        <span className="font-normal">{option.label}</span>
                        {option.isNew && (
                          <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted rounded-[4px] border px-1.5 py-0.5 text-[10px] tracking-[0.08em] uppercase">
                            New
                          </span>
                        )}
                        {isSelected && <Check className="text-text-primary ml-auto h-3.5 w-3.5" />}
                      </DropdownMenuItem>
                    );
                  }
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Thinking cycle button */}
            <InputGroupButton
              variant="ghost"
              size="sm"
              onClick={cycleThinkingLevel}
              title={`Thinking: ${thinkingLevel}`}
              aria-label={`Thinking level: ${thinkingLevel}`}
              className={cn(
                "rounded-full",
                thinkingLevel !== "NONE" ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Brain className="h-3 w-3" />
              {renderThinkingDots()}
            </InputGroupButton>
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
                className="text-warning rounded-sm border"
              >
                <Minimize2 className="size-3" />
                <span className="text-xs font-normal">Compact</span>
              </Button>
            )}

            {/* Context window indicator - circular progress */}
            <div
              className="relative flex h-8 w-8 shrink-0 items-center justify-center"
              title={`Context: ${contextTokenCount.toLocaleString()} / ${MAX_TOKENS.toLocaleString()} tokens (${contextPercentage.toFixed(1)}%)`}
            >
              <svg className="h-4 w-4 -rotate-90" viewBox="0 0 16 16">
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
                  className="transition-all duration-300"
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
              className={browserEnabled ? "text-info" : "text-muted-foreground"}
            >
              <Globe className="h-4 w-4" />
            </InputGroupButton>

            {/* MCP Server indicator */}
            <Popover>
              <PopoverTrigger asChild>
                <InputGroupButton
                  variant="ghost"
                  size="icon-sm"
                  title={`MCP Servers${activeMCPCount > 0 ? ` (${activeMCPCount} active)` : ""}`}
                  aria-label="MCP Servers"
                  className={activeMCPCount > 0 ? "text-primary" : "text-muted-foreground"}
                >
                  <Hammer className="h-4 w-4" />
                </InputGroupButton>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="end" side="top">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">MCP Servers</p>
                    <Badge variant="secondary" className="text-xs">
                      {activeMCPCount}/{mcpServers.length}
                    </Badge>
                  </div>

                  {mcpServers.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No servers configured</p>
                  ) : (
                    <div className="space-y-2">
                      {mcpServers.map((server) => (
                        <div key={server.name} className="flex items-center justify-between py-1">
                          <span className="flex-1 truncate text-sm">{server.name}</span>
                          <Badge
                            variant={server.active ? "default" : "secondary"}
                            className="ml-2 text-xs"
                          >
                            {server.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Stop button - shows when session is working */}
            {sessionStatus === "working" && (
              <InputGroupButton
                onClick={onStop}
                variant="destructive"
                size="icon-sm"
                title="Stop execution"
                className="rounded-full"
              >
                <Square className="h-5 w-5" />
              </InputGroupButton>
            )}

            {/* Send button - always visible, highlighted when content exists */}
            <InputGroupButton
              onClick={handleSend}
              disabled={sending || !hasContent}
              variant={hasContent ? "default" : "outline"}
              size="icon-sm"
              title="Send message (⌘ + Enter)"
              aria-label="Send message"
              className="rounded-full"
            >
              <ArrowUp className="h-5 w-5" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
});
