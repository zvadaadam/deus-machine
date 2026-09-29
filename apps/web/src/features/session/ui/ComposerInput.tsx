import type { ComponentProps, ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { cn } from "@/shared/lib/utils";

interface ComposerInputProps {
  textarea: ComponentProps<"textarea">;
  hasContent: boolean;
  sending: boolean;
  disabled?: boolean;
  onSend: () => void;
  onStop?: () => void;
  stopDisabled?: boolean;
  modelControls: ReactNode;
  actions?: ReactNode;
  feedback?: ReactNode;
  /** Staged attachments and the file/skill pickers live above the textarea. */
  children?: ReactNode;
}

/** Shared workspace and Project composer surface; callers own drafting and delivery. */
export function ComposerInput({
  textarea,
  hasContent,
  sending,
  disabled = false,
  onSend,
  onStop,
  stopDisabled,
  modelControls,
  actions,
  feedback,
  children,
}: ComposerInputProps) {
  const isMobile = useIsMobile();
  const sendDisabled = disabled || sending || !hasContent;
  const send = () => {
    if (!sendDisabled) onSend();
  };
  return (
    <InputGroup
      data-no-ring={true}
      className="bg-bg-muted/75 ring-border-subtle relative overflow-visible rounded-2xl border-0 shadow-sm ring-1 backdrop-blur-xl"
    >
      {children}
      <InputGroupTextarea
        aria-label="Message"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        {...textarea}
        disabled={disabled || sending}
        className={cn(
          "placeholder:text-placeholder max-h-48 min-h-12 overflow-y-auto px-4 py-3",
          textarea.className
        )}
        onKeyDown={(event) => {
          textarea.onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            event.key === "Enter" &&
            !isMobile &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
        }}
      />
      {feedback}
      <InputGroupAddon
        align="block-end"
        className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pt-0 pb-2"
      >
        <div className="flex items-center gap-0.5">{modelControls}</div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
          {onStop && (
            <InputGroupButton
              onClick={onStop}
              disabled={stopDisabled}
              variant="default"
              size="icon-sm"
              title="Stop execution"
              aria-label="Stop execution"
              className="rounded-full"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </InputGroupButton>
          )}
          <InputGroupButton
            onClick={send}
            disabled={sendDisabled}
            variant={hasContent ? "default" : "outline"}
            size="icon-sm"
            title={isMobile ? "Send message" : "Send message (Enter)"}
            aria-label="Send message"
            className="rounded-full"
          >
            <ArrowUp className="h-4 w-4" />
          </InputGroupButton>
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}
