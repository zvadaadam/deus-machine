/**
 * Message Item
 *
 * Renders a single message in the chat:
 * - Assistant messages: rendered via PartsRenderer (Parts model)
 * - User messages: iMessage-style bubble with text + images
 */

import { tempo } from "@/shared/lib/tempo";
import type { Message } from "@/shared/types";
import { readUserMessageContent } from "../lib/userMessageContent";
import { PartsRenderer } from "./blocks";
import { TextBlock } from "./blocks/TextBlock";
import { SentFrom } from "./SentFrom";

import { cn } from "@/shared/lib/utils";
import { Copy, ChevronDown, ChevronUp } from "lucide-react";
import { ActionButton } from "./ActionButton";
import { useCopyToClipboard } from "@/shared/hooks";
import { useMemo, memo, useState, useRef, useEffect } from "react";
import { m, useReducedMotion } from "framer-motion";

const COLLAPSE_MAX_HEIGHT = 144;

interface MessageItemProps {
  message: Message;
  isLastInTurn?: boolean;
  isStreamingTurn?: boolean;
}

/** Assistant message — renders via PartsRenderer. */
const AssistantMessage = memo(function AssistantMessage({
  message,
  isLastInTurn = false,
  isStreamingTurn = false,
}: MessageItemProps) {
  if (!message.parts || message.parts.length === 0) return null;

  return (
    <div
      className={cn(
        "relative",
        "mr-auto w-full max-w-full",
        "flex min-w-0 flex-col gap-1 overflow-x-hidden"
      )}
    >
      <PartsRenderer parts={message.parts} isStreamingTurn={isStreamingTurn && isLastInTurn} />
    </div>
  );
});

/** User message — iMessage-style bubble. */
const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const { copy, copied } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const reduced = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);

  /**
   * `parts` is the source of truth — the engine's user echo, and the composer's
   * optimistic bubble, which builds the same shapes locally.
   */
  const { images, texts } = useMemo(() => readUserMessageContent(message), [message]);

  const hasTextContent = texts.length > 0;

  useEffect(() => {
    if (contentRef.current) {
      setShouldCollapse(contentRef.current.scrollHeight > COLLAPSE_MAX_HEIGHT);
    }
  }, [images, texts]);

  const handleCopy = () => copy(texts.join("\n"));

  return (
    <div className="group relative flex flex-col items-end gap-1">
      {message.origin && <SentFrom origin={message.origin} />}
      <div
        className={cn(
          "max-w-[85%]",
          "bg-accent hover:bg-accent/80 ml-auto w-fit backdrop-blur-sm transition-colors",
          "relative rounded-xl",
          "px-3 py-2",
          "min-w-0"
        )}
      >
        <div className="pointer-events-none absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <ActionButton
            icon={Copy}
            label={copied ? "Copied" : "Copy"}
            onClick={handleCopy}
            active={copied}
            showLabel={false}
            className="bg-accent/80 rounded-md backdrop-blur-sm"
          />
        </div>

        {images.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", hasTextContent && "mb-2")}>
            {images.map((src, idx) => (
              <div
                key={`${message.id}:img:${idx}`}
                className="border-border/60 h-[80px] w-[80px] shrink-0 overflow-hidden rounded-lg border"
              >
                <img src={src} alt="Pasted image" className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        )}

        {hasTextContent && (
          <m.div
            ref={contentRef}
            id={`message-content-${message.id}`}
            className="relative min-w-0 overflow-hidden"
            animate={
              shouldCollapse
                ? { height: isExpanded ? "auto" : COLLAPSE_MAX_HEIGHT }
                : { height: "auto" }
            }
            initial={false}
            transition={
              reduced ? { type: false } : isExpanded ? tempo.moderate : tempo.moderate.exit
            }
          >
            {texts.map((text, idx) => (
              <TextBlock key={`${message.id}:text:${idx}`} block={text} role="user" />
            ))}

            {shouldCollapse && !isExpanded && (
              <div className="from-accent via-accent/60 pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t to-transparent" />
            )}
          </m.div>
        )}

        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs font-normal transition-colors"
            aria-expanded={isExpanded}
            aria-controls={`message-content-${message.id}`}
          >
            {isExpanded ? (
              <>
                Show less
                <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                Show more
                <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
});

/** Route to AssistantMessage or UserMessage based on role. */
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (props.message.role === "assistant") {
    return <AssistantMessage {...props} />;
  }
  return <UserMessage message={props.message} />;
});
