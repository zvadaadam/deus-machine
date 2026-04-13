/**
 * Message Item
 *
 * Renders a single message in the chat:
 * - Assistant messages: rendered via PartsRenderer (Parts model)
 * - User messages: iMessage-style bubble with text + images
 */

import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { isImageBlock, isTextBlock } from "@/features/session/types";
import { PartsRenderer } from "./blocks";

import { cn } from "@/shared/lib/utils";
import { Copy, ChevronDown, ChevronUp } from "lucide-react";
import { ActionButton } from "./ActionButton";
import { useCopyToClipboard } from "@/shared/hooks";
import { useMemo, memo, useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";

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
  const hasParts = message.parts && message.parts.length > 0;

  if (!hasParts && !message.content) return null;

  if (hasParts) {
    return (
      <div
        className={cn(
          "relative",
          "mr-auto max-w-full",
          "flex min-w-0 flex-col gap-2 overflow-x-hidden"
        )}
      >
        <PartsRenderer parts={message.parts!} isStreamingTurn={isStreamingTurn && isLastInTurn} />
      </div>
    );
  }

  return <div className="mr-auto max-w-full px-2 py-1.5 text-sm opacity-60">{message.content}</div>;
});

/** User message — iMessage-style bubble. */
const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const { copy, copied } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const contentBlocks = useMemo(() => {
    try {
      const parsed = JSON.parse(message.content);
      if (Array.isArray(parsed)) return parsed as (ContentBlock | string)[];
      if (typeof parsed === "string") return [{ type: "text" as const, text: parsed }];
      return [{ type: "text" as const, text: message.content }];
    } catch {
      return [{ type: "text" as const, text: message.content }];
    }
  }, [message.content]);

  const { imageBlocks, textBlocks } = useMemo(() => {
    const images: ContentBlock[] = [];
    const texts: (ContentBlock | string)[] = [];
    for (const block of contentBlocks) {
      if (isImageBlock(block)) {
        images.push(block);
      } else {
        texts.push(block);
      }
    }
    return { imageBlocks: images, textBlocks: texts };
  }, [contentBlocks]);

  const hasTextContent = textBlocks.length > 0;

  useEffect(() => {
    if (contentRef.current) {
      setShouldCollapse(contentRef.current.scrollHeight > COLLAPSE_MAX_HEIGHT);
    }
  }, [contentBlocks]);

  const extractTextContent = (): string => {
    return contentBlocks
      .map((block) => {
        if (typeof block === "string") return block;
        if (isTextBlock(block)) return block.text;
        return "";
      })
      .join("\n");
  };

  const handleCopy = () => copy(extractTextContent());

  return (
    <div className="group relative flex flex-col items-end">
      <div
        className={cn(
          "max-w-[85%]",
          "bg-accent hover:bg-accent/80 ml-auto w-fit backdrop-blur-sm transition-colors duration-200 ease-out motion-reduce:transition-none",
          "relative rounded-xl",
          "px-3 py-2",
          "min-w-0"
        )}
      >
        <div className="pointer-events-none absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity duration-200 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <ActionButton
            icon={Copy}
            label={copied ? "Copied" : "Copy"}
            onClick={handleCopy}
            active={copied}
            showLabel={false}
            className="bg-accent/80 rounded-md backdrop-blur-sm"
          />
        </div>

        {imageBlocks.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", hasTextContent && "mb-2")}>
            {imageBlocks.map((block, idx) => {
              if (!isImageBlock(block)) return null;
              return (
                <div
                  key={`${message.id}:img:${idx}`}
                  className="border-border/60 h-[80px] w-[80px] shrink-0 overflow-hidden rounded-lg border"
                >
                  <img
                    src={`data:${block.source.media_type};base64,${block.source.data}`}
                    alt="Pasted image"
                    className="h-full w-full object-cover"
                  />
                </div>
              );
            })}
          </div>
        )}

        {hasTextContent && (
          <motion.div
            ref={contentRef}
            id={`message-content-${message.id}`}
            className="relative min-w-0 overflow-hidden"
            animate={
              shouldCollapse
                ? { height: isExpanded ? "auto" : COLLAPSE_MAX_HEIGHT }
                : { height: "auto" }
            }
            initial={false}
            transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
          >
            {textBlocks.map((block, idx) => {
              const text = typeof block === "string" ? block : isTextBlock(block) ? block.text : "";
              return (
                <p
                  key={`${message.id}:text:${idx}`}
                  className="text-foreground text-base font-normal whitespace-pre-wrap"
                >
                  {text}
                </p>
              );
            })}

            {shouldCollapse && !isExpanded && (
              <div className="from-accent via-accent/60 pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t to-transparent" />
            )}
          </motion.div>
        )}

        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs font-normal transition-colors duration-200"
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
