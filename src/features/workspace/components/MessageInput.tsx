import type { SessionStatus } from "../../../types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
      onSend();
    }
  };

  return (
    <div className="flex-shrink-0 m-0 p-4 border-t border-border z-10 shadow-[0_-2px_10px_rgba(0,0,0,0.05)] flex flex-col gap-3">
      {!embedded && (
        <div className="flex gap-2 justify-end">
          <Button
            onClick={onCompact}
            disabled={sending || isCompacting}
            variant="secondary"
            size="sm"
            title="Compact conversation to reduce context size"
            className="gap-1.5 text-[13px] px-3 py-1.5"
          >
            {isCompacting ? '🔄' : '📦'}
            {isCompacting ? 'Compacting...' : 'Compact'}
          </Button>
          <Button
            onClick={onCreatePR}
            disabled={sending}
            variant="default"
            size="sm"
            title="Send 'Create a PR onto main' message"
            className="gap-1.5 text-[13px] px-3 py-1.5 bg-success-600 hover:bg-success-700"
          >
            🔀
            Create PR
          </Button>
          {sessionStatus === 'working' && (
            <Button
              onClick={onStop}
              variant="destructive"
              size="sm"
              title="Stop Claude Code execution"
              className="gap-1.5 text-[13px] px-3 py-1.5"
            >
              ⏹
              Stop
            </Button>
          )}
        </div>
      )}
      <div className="flex gap-3 items-end">
        <Textarea
          value={messageInput}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Ask Claude Code to make changes, @mention files, run /commands"
          disabled={sending}
          onKeyDown={handleKeyDown}
          className="flex-1 min-h-[100px] max-h-[250px] resize-y transition-all duration-200"
        />
        <Button
          onClick={onSend}
          disabled={sending || !messageInput.trim()}
          size="default"
          className="gap-2 whitespace-nowrap h-fit"
        >
          {sending ? '⟳' : '➤'}
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
