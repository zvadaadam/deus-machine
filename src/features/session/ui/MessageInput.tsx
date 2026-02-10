import type { SessionStatus } from "@/shared/types";
import { useState } from "react";
import {
  Minimize2,
  ArrowUp,
  Square,
  Brain,
  Paperclip,
  X,
  Plus,
  Hammer,
  Globe,
  ChevronDown,
} from "lucide-react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

interface Attachment {
  id: string;
  file: File;
  preview: string;
  type: string;
}

interface MCPServer {
  name: string;
  active: boolean;
  command: string;
}

interface MessageInputProps {
  messageInput: string;
  sending: boolean;
  isCompacting?: boolean;
  sessionStatus?: SessionStatus;
  embedded?: boolean;
  model?: string;
  thinkingLevel?: string;
  showCompactButton?: boolean;
  mcpServers?: MCPServer[];
  contextTokenCount?: number;
  onMessageChange: (value: string) => void;
  onSend: () => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
  onThinkingLevelChange?: (level: string) => void;
  onAttachmentClick?: () => void;
  className?: string;
}

export function MessageInput({
  messageInput,
  sending,
  isCompacting = false,
  sessionStatus,
  embedded = false,
  model = "sonnet",
  thinkingLevel = "NONE",
  showCompactButton = false,
  mcpServers = [],
  contextTokenCount = 0,
  onMessageChange,
  onSend,
  onCompact,
  onCreatePR,
  onStop,
  onModelChange,
  onThinkingLevelChange,
  onAttachmentClick,
  className,
}: MessageInputProps) {
  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Browser MCP state (future integration)
  const [browserEnabled, setBrowserEnabled] = useState(false);

  // Keyboard shortcut
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sending && messageInput.trim()) {
        onSend();
      }
    }
  };

  // Model display label (full version numbers)
  const modelLabel = model === "opus" ? "Opus 3" : model === "haiku" ? "Haiku 3.5" : "Sonnet 4.5";

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

  // Drag & Drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));

    if (files.length === 0) {
      // TODO: Show toast - "Only image files are supported"
      return;
    }

    const previews = await Promise.all(
      files.map((file) => {
        return new Promise<Attachment>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) =>
            resolve({
              id: crypto.randomUUID(),
              file,
              preview: e.target?.result as string,
              type: file.type,
            });
          reader.readAsDataURL(file);
        });
      })
    );

    setAttachments((prev) => [...prev, ...previews]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className={cn("relative shrink-0 px-4 pb-4", className)}>
      {/* Scroll fade overlay */}
      <div className="bg-fade-overlay pointer-events-none absolute right-0 bottom-full left-0 h-8 translate-y-2" />

      {/* InputGroup with drag & drop */}
      <InputGroup
        data-no-ring={true}
        className="bg-input-surface relative overflow-visible rounded-2xl border-0 shadow-xs transition-colors duration-200"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="bg-primary/10 border-primary pointer-events-none absolute inset-0 z-1 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed">
            <Paperclip className="text-primary h-8 w-8" />
            <p className="text-primary text-sm font-medium">Drop files here</p>
          </div>
        )}

        {/* Attachment previews - inside InputGroup */}
        {attachments.length > 0 && (
          <div className="scrollbar-vibrancy flex w-full items-start justify-start gap-3 overflow-x-auto px-3 pt-3">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group border-border bg-muted relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border"
              >
                <img
                  src={attachment.preview}
                  className="h-full w-full object-cover"
                  alt={attachment.file.name}
                />
                {/* Remove button */}
                <button
                  onClick={() => removeAttachment(attachment.id)}
                  className="bg-muted absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label="Remove attachment"
                >
                  <X className="text-muted-foreground h-3 w-3" />
                </button>
                {/* File name */}
                <div className="bg-muted text-muted-foreground text-2xs absolute right-0 bottom-0 left-0 truncate px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {attachment.file.name}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <InputGroupTextarea
          value={messageInput}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Ask a follow-up ..."
          disabled={sending}
          onKeyDown={handleKeyDown}
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
              <DropdownMenuContent>
                <DropdownMenuLabel>
                  <span className="text-muted-foreground text-xs">Claude Code</span>
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onModelChange?.("opus")}>
                  <span className="font-family-mono text-xs font-medium uppercase">Opus 3</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onModelChange?.("sonnet")}>
                  <span className="font-family-mono text-xs font-medium uppercase">Sonnet 4.5</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onModelChange?.("haiku")}>
                  <span className="font-family-mono text-xs font-medium uppercase">Haiku 3.5</span>
                </DropdownMenuItem>
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
                disabled={sending || isCompacting}
                title="Compact conversation"
                variant="ghost"
                size="sm"
                className="text-warning rounded-sm border"
              >
                <Minimize2 className="size-3" />
                <span className="text-xs font-normal">
                  {isCompacting ? "Compacting..." : "Compact"}
                </span>
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

            {/* Send button - always visible, highlighted when text exists */}
            <InputGroupButton
              onClick={onSend}
              disabled={sending || !messageInput.trim()}
              variant={messageInput.trim() ? "default" : "outline"}
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
}
