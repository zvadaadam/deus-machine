import type { SessionStatus } from "@/shared/types";
import { Minimize2, Wrench, ArrowUp, Square, Sparkles, Brain, Paperclip } from "lucide-react";
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

interface MessageInputProps {
  messageInput: string;
  sending: boolean;
  isCompacting?: boolean;
  sessionStatus?: SessionStatus;
  embedded?: boolean;
  model?: string;
  thinkingLevel?: string;
  onMessageChange: (value: string) => void;
  onSend: () => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
  onModelChange?: (model: string) => void;
  onThinkingLevelChange?: (level: string) => void;
  onAttachment?: () => void;
}

export function MessageInput({
  messageInput,
  sending,
  isCompacting = false,
  sessionStatus,
  embedded = false,
  model = 'sonnet',
  thinkingLevel = 'NONE',
  onMessageChange,
  onSend,
  onCompact,
  onCreatePR,
  onStop,
  onModelChange,
  onThinkingLevelChange,
  onAttachment,
}: MessageInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sending && messageInput.trim()) {
        onSend();
      }
    }
  };

  // Model display labels
  const modelLabel = model === 'opus' ? 'Opus' : model === 'haiku' ? 'Haiku' : 'Sonnet';

  // Thinking level display labels
  const thinkingLabel =
    thinkingLevel === 'HIGH' ? 'High' :
    thinkingLevel === 'MEDIUM' ? 'Med' :
    thinkingLevel === 'LOW' ? 'Low' : 'None';

  return (
    <div className="relative flex-shrink-0 m-0 px-6 pb-4 z-10">
      {/* Scroll fade overlay - positioned above the input */}
      <div
        className="absolute bottom-full left-0 right-0 h-32 pointer-events-none"
        style={{
          background: 'linear-gradient(to bottom, transparent 0%, hsl(var(--background)) 100%)'
        }}
      />

      {/* InputGroup with glassmorphic styling */}
      <InputGroup className="rounded-[24px] shadow-lg bg-muted/30 backdrop-blur-xl border-border/50 has-[[data-slot=input-group-control]:focus-visible]:border-primary/50 has-[[data-slot=input-group-control]:focus-visible]:shadow-xl hover:border-border transition-all duration-200">
        {/* Textarea - auto-resizes via CSS field-sizing-content */}
        <InputGroupTextarea
          value={messageInput}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Ask Claude Code to make changes, @mention files, run /commands"
          disabled={sending}
          onKeyDown={handleKeyDown}
          className="min-h-[40px] max-h-[200px] text-body-lg resize-none overflow-y-auto scrollbar-vibrancy"
        />

        {/* Bottom toolbar - block-end */}
        <InputGroupAddon align="block-end">
          {/* Model picker dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md hover:bg-muted/50 transition-colors">
              <Sparkles className="w-4 h-4" />
              <span>{modelLabel}</span>
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

          {/* Thinking intensity dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md hover:bg-muted/50 transition-colors">
              <Brain className="w-4 h-4" />
              <span>{thinkingLabel}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => onThinkingLevelChange?.('NONE')}>
                None
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onThinkingLevelChange?.('LOW')}>
                Low
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onThinkingLevelChange?.('MEDIUM')}>
                Medium
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onThinkingLevelChange?.('HIGH')}>
                High
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Attachment button */}
          <InputGroupButton
            onClick={onAttachment}
            size="icon-sm"
            title="Add attachment"
          >
            <Paperclip className="w-4 h-4" />
          </InputGroupButton>

          {/* Spacer for non-embedded mode */}
          {!embedded && <div className="flex-1" />}

          {/* Compact & PR buttons (non-embedded only) */}
          {!embedded && (
            <>
              <InputGroupButton
                onClick={onCompact}
                disabled={sending || isCompacting}
                title="Compact conversation"
                size="sm"
              >
                <Minimize2 className="w-4 h-4" />
                <span>{isCompacting ? 'Compacting...' : 'Compact'}</span>
              </InputGroupButton>

              <InputGroupButton
                onClick={onCreatePR}
                disabled={sending}
                title="Create PR"
                size="sm"
              >
                <Wrench className="w-4 h-4" />
                <span>Create PR</span>
              </InputGroupButton>

              {/* Send/Stop toggle */}
              {sessionStatus === 'working' ? (
                <InputGroupButton
                  onClick={onStop}
                  variant="destructive"
                  size="icon-sm"
                  title="Stop execution"
                >
                  <Square className="w-5 h-5" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  onClick={onSend}
                  disabled={sending || !messageInput.trim()}
                  size="icon-sm"
                  title="Send message (⌘ + Enter)"
                  aria-label="Send message"
                >
                  <ArrowUp className="w-5 h-5" />
                </InputGroupButton>
              )}
            </>
          )}
        </InputGroupAddon>

        {/* Embedded mode: Send/Stop on inline-end */}
        {embedded && (
          <InputGroupAddon align="inline-end">
            {sessionStatus === 'working' ? (
              <InputGroupButton
                onClick={onStop}
                variant="destructive"
                size="icon-sm"
                title="Stop execution"
              >
                <Square className="w-5 h-5" />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                onClick={onSend}
                disabled={sending || !messageInput.trim()}
                size="icon-sm"
                title="Send message (⌘ + Enter)"
                aria-label="Send message"
              >
                <ArrowUp className="w-5 h-5" />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  );
}
