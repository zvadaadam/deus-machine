import type { SessionStatus } from "@/shared/types";
import { useState } from "react";
import { Minimize2, Wrench, ArrowUp, Square, Sparkles, Brain, Paperclip, X, Plus, Hammer } from "lucide-react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
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
  onMessageChange: (value: string) => void;
  onSend: () => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
  onThinkingLevelChange?: (level: string) => void;
  onAttachmentClick?: () => void;
}

export function MessageInput({
  messageInput,
  sending,
  isCompacting = false,
  sessionStatus,
  embedded = false,
  model = 'sonnet',
  thinkingLevel = 'NONE',
  showCompactButton = false,
  mcpServers = [],
  onMessageChange,
  onSend,
  onCompact,
  onCreatePR,
  onStop,
  onModelChange,
  onThinkingLevelChange,
  onAttachmentClick,
}: MessageInputProps) {
  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Keyboard shortcut
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sending && messageInput.trim()) {
        onSend();
      }
    }
  };

  // Model display label
  const modelLabel = model === 'opus' ? 'Opus' : model === 'haiku' ? 'Haiku' : 'Sonnet';

  // Thinking level - cycle through levels
  const cycleThinkingLevel = () => {
    const levels = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
    const currentIndex = levels.indexOf(thinkingLevel);
    const nextLevel = levels[(currentIndex + 1) % levels.length];
    onThinkingLevelChange?.(nextLevel);
  };

  // Thinking dot indicators
  const renderThinkingDots = () => {
    if (thinkingLevel === 'NONE') return null;

    const dotCount =
      thinkingLevel === 'HIGH' ? 3 :
      thinkingLevel === 'MEDIUM' ? 2 : 1;

    return (
      <div className="flex flex-col gap-0.5 ml-1">
        {Array.from({ length: dotCount }).map((_, i) => (
          <span key={i} className="w-1 h-1 rounded-full bg-primary" />
        ))}
      </div>
    );
  };

  // MCP active count
  const activeMCPCount = mcpServers.filter(s => s.active).length;

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
      e.clientX < rect.left || e.clientX >= rect.right ||
      e.clientY < rect.top || e.clientY >= rect.bottom
    ) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/')
    );

    if (files.length === 0) {
      // TODO: Show toast - "Only image files are supported"
      return;
    }

    const previews = await Promise.all(
      files.map(file => {
        return new Promise<Attachment>(resolve => {
          const reader = new FileReader();
          reader.onload = (e) => resolve({
            id: crypto.randomUUID(),
            file,
            preview: e.target?.result as string,
            type: file.type,
          });
          reader.readAsDataURL(file);
        });
      })
    );

    setAttachments(prev => [...prev, ...previews]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  return (
    <div className="relative flex-shrink-0 m-0 p-4 z-10">
      {/* Scroll fade overlay */}
      <div className="absolute bottom-full left-0 right-0 h-32 pointer-events-none bg-fade-overlay" />

      {/* InputGroup with drag & drop */}
      <InputGroup
        className="relative rounded-[24px] shadow-lg bg-muted/30 backdrop-blur-xl border-border/50 hover:border-border transition-all duration-200 !ring-0 overflow-visible"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 bg-primary/10 border-2 border-primary border-dashed rounded-[24px] flex flex-col items-center justify-center gap-2 pointer-events-none z-10">
            <Paperclip className="w-8 h-8 text-primary" />
            <p className="text-primary font-medium text-sm">Drop files here</p>
          </div>
        )}

        {/* Attachment previews - inside InputGroup */}
        {attachments.length > 0 && (
          <div className="flex gap-3 p-4 pb-3 overflow-x-auto scrollbar-vibrancy">
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className="relative group w-20 h-20 rounded-lg overflow-hidden border border-border bg-muted flex-shrink-0"
              >
                <img
                  src={attachment.preview}
                  className="w-full h-full object-cover"
                  alt={attachment.file.name}
                />
                {/* Remove button */}
                <button
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  aria-label="Remove attachment"
                >
                  <X className="w-3 h-3 text-muted-foreground" />
                </button>
                {/* File name */}
                <div className="absolute bottom-0 left-0 right-0 bg-muted text-muted-foreground text-[10px] px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
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
          placeholder="Ask Claude Code to make changes, @mention files, run /commands"
          disabled={sending}
          onKeyDown={handleKeyDown}
          className="min-h-[40px] max-h-[200px] text-body-lg resize-none overflow-y-auto scrollbar-vibrancy"
        />

        {/* Bottom toolbar */}
        <InputGroupAddon align="block-end" className="w-full flex items-center justify-between gap-4">
          {/* Controls group (left) */}
          <div className="flex items-center gap-1.5">
              {/* Add attachment button */}
              <InputGroupButton
                onClick={onAttachmentClick}
                size="icon-sm"
                title="Add attachment"
              >
                <Plus className="w-4 h-4" />
              </InputGroupButton>

              {/* Model picker dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton
                    size="sm"
                    title="Select model"
                    aria-label={`Select model, currently ${modelLabel}`}
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>{modelLabel}</span>
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => onModelChange?.('sonnet')}>
                    Claude 3.5 Sonnet
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onModelChange?.('opus')}>
                    Claude 3 Opus
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onModelChange?.('haiku')}>
                    Claude 3.5 Haiku
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Thinking cycle button */}
              <InputGroupButton
                size="sm"
                onClick={cycleThinkingLevel}
                title={`Thinking: ${thinkingLevel}`}
                aria-label={`Thinking level: ${thinkingLevel}`}
                className={cn(
                  "gap-1",
                  thinkingLevel !== 'NONE' && "text-primary"
                )}
              >
                <Brain className="w-4 h-4" />
                {renderThinkingDots()}
              </InputGroupButton>

              {/* MCP Server indicator */}
              <Popover>
                <PopoverTrigger asChild>
                  <InputGroupButton
                    size="icon-sm"
                    title="MCP Servers"
                    aria-label="MCP Servers"
                  >
                    <Hammer className="w-4 h-4" />
                  </InputGroupButton>
                </PopoverTrigger>
                <PopoverContent className="w-64" align="start" side="top">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-sm">MCP Servers</p>
                      <Badge variant="secondary" className="text-xs">
                        {activeMCPCount}/{mcpServers.length}
                      </Badge>
                    </div>

                    {mcpServers.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No servers configured</p>
                    ) : (
                      <div className="space-y-2">
                        {mcpServers.map(server => (
                          <div key={server.name} className="flex items-center justify-between py-1">
                            <span className="text-sm truncate flex-1">{server.name}</span>
                            <Badge
                              variant={server.active ? 'default' : 'secondary'}
                              className="text-xs ml-2"
                            >
                              {server.active ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
          </div>

          {/* Actions group (right) */}
          <div className="flex items-center gap-1.5">
              {/* Compact button (conditional) */}
              {showCompactButton && !embedded && (
                <InputGroupButton
                  onClick={onCompact}
                  disabled={sending || isCompacting}
                  title="Compact conversation"
                  size="sm"
                >
                  <Minimize2 className="w-4 h-4" />
                  <span>{isCompacting ? 'Compacting...' : 'Compact'}</span>
                </InputGroupButton>
              )}

              {/* Create PR button (non-embedded) */}
              {!embedded && (
                <InputGroupButton
                  onClick={onCreatePR}
                  disabled={sending}
                  title="Create PR"
                  size="sm"
                >
                  <Wrench className="w-4 h-4" />
                  <span>Create PR</span>
                </InputGroupButton>
              )}

              {/* Stop button - shows when session is working */}
              {sessionStatus === 'working' && (
                <InputGroupButton
                  onClick={onStop}
                  variant="destructive"
                  size="icon-sm"
                  title="Stop execution"
                >
                  <Square className="w-5 h-5" />
                </InputGroupButton>
              )}

              {/* Send button - always visible, highlighted when text exists */}
              <InputGroupButton
                onClick={onSend}
                disabled={sending || !messageInput.trim()}
                variant={messageInput.trim() ? 'default' : 'outline'}
                size="icon-sm"
                title="Send message (⌘ + Enter)"
                aria-label="Send message"
              >
                <ArrowUp className="w-5 h-5" />
              </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
