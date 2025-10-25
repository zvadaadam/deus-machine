import type { SessionStatus } from "@/shared/types";
import { Search, Minimize2, Wrench, ArrowUp, Square } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";

interface MessageInputProps {
  messageInput: string;
  sending: boolean;
  isCompacting?: boolean;
  sessionStatus?: SessionStatus;
  embedded?: boolean;
  onMessageChange: (value: string) => void;
  onSend: () => void;
  onCompact?: () => void;
  onCreatePR?: () => void;
  onStop?: () => void;
}

export function MessageInput({
  messageInput,
  sending,
  isCompacting = false,
  sessionStatus,
  embedded = false,
  onMessageChange,
  onSend,
  onCompact,
  onCreatePR,
  onStop,
}: MessageInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sending && messageInput.trim()) {
        onSend();
      }
    }
  };

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
        {/* Search icon - inline-start */}
        <InputGroupAddon align="inline-start">
          <Search className="w-5 h-5" aria-hidden="true" />
        </InputGroupAddon>

        {/* Textarea - auto-resizes via CSS field-sizing-content */}
        <InputGroupTextarea
          value={messageInput}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Ask Claude Code to make changes, @mention files, run /commands"
          disabled={sending}
          onKeyDown={handleKeyDown}
          className="min-h-[40px] max-h-[200px] text-body-lg resize-none overflow-y-auto scrollbar-vibrancy"
        />

        {/* Action buttons - block-end (bottom alignment for textarea) */}
        {!embedded && (
          <InputGroupAddon align="block-end">
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

            {sessionStatus === 'working' && (
              <InputGroupButton
                onClick={onStop}
                title="Stop execution"
                variant="destructive"
                size="sm"
              >
                <Square className="w-4 h-4" />
                <span>Stop</span>
              </InputGroupButton>
            )}
          </InputGroupAddon>
        )}

        {/* Send button - inline-end */}
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            onClick={onSend}
            disabled={sending || !messageInput.trim()}
            title="Send message (⌘ + Enter)"
            aria-label="Send message"
            size="icon-sm"
          >
            <ArrowUp className="w-5 h-5" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
