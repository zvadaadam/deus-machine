import type { SessionStatus } from "../../../types";
import { Search, Minimize2, Wrench, ArrowUp, Square } from "lucide-react";
import { useState, useRef, useEffect } from "react";

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
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [messageInput]);

  return (
    <div className="flex-shrink-0 m-0 px-6 pb-4 z-10 flex flex-col gap-3">
      {/* Glassmorphic ChatBox */}
      <div
        className={`
          relative flex items-center gap-3 px-5 py-4
          bg-muted/30 backdrop-blur-xl
          border border-border/50
          rounded-[24px]
          shadow-lg
          transition-all duration-200 ease-out
          ${isFocused ? 'border-primary/50 shadow-xl' : 'hover:border-border'}
        `}
      >
        {/* Search Icon */}
        <Search className="w-5 h-5 text-muted-foreground flex-shrink-0" aria-hidden="true" />

        {/* Input Field */}
        <textarea
          ref={textareaRef}
          value={messageInput}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Ask Claude Code to make changes, @mention files, run /commands"
          disabled={sending}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          className="
            flex-1 bg-transparent border-none outline-none resize-none
            text-body-lg text-foreground placeholder:text-muted-foreground
            min-h-[24px] max-h-[200px]
            font-sans
            overflow-y-auto
            scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent
          "
          rows={1}
        />

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {!embedded && (
            <>
              <button
                type="button"
                onClick={onCompact}
                disabled={sending || isCompacting}
                title="Compact conversation"
                className="
                  flex items-center gap-2 px-4 py-2
                  bg-transparent hover:bg-muted/50
                  border border-border/50 hover:border-border
                  rounded-full
                  text-body-sm text-muted-foreground hover:text-foreground
                  transition-all duration-200 ease
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
              >
                <Minimize2 className="w-4 h-4" aria-hidden="true" />
                <span>{isCompacting ? 'Compacting...' : 'Compact'}</span>
              </button>

              <button
                type="button"
                onClick={onCreatePR}
                disabled={sending}
                title="Create PR"
                className="
                  flex items-center gap-2 px-4 py-2
                  bg-transparent hover:bg-muted/50
                  border border-border/50 hover:border-border
                  rounded-full
                  text-body-sm text-muted-foreground hover:text-foreground
                  transition-all duration-200 ease
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
              >
                <Wrench className="w-4 h-4" aria-hidden="true" />
                <span>Create PR</span>
              </button>

              {sessionStatus === 'working' && (
                <button
                  type="button"
                  onClick={onStop}
                  title="Stop execution"
                  className="
                    flex items-center gap-2 px-4 py-2
                    bg-destructive/10 hover:bg-destructive/20
                    border border-destructive/50 hover:border-destructive
                    rounded-full
                    text-body-sm text-destructive-foreground
                    transition-all duration-200 ease
                  "
                >
                  <Square className="w-4 h-4" aria-hidden="true" />
                  <span>Stop</span>
                </button>
              )}
            </>
          )}

          {/* Send Button */}
          <button
            type="button"
            onClick={onSend}
            disabled={sending || !messageInput.trim()}
            title="Send message (⌘ + Enter)"
            aria-label="Send message"
            className="
              p-2
              text-muted-foreground hover:text-foreground
              transition-colors duration-200 ease
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            <ArrowUp className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
