/**
 * Message Item (Refactored)
 *
 * Uses the new registry pattern with BlockRenderer for extensible content rendering.
 * Automatically imports and registers all tool renderers.
 */

import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { isImageBlock, isTextBlock, isToolUseBlock } from "@/features/session/types";
import { BlockRenderer, ToolGroupBlock, PartsRenderer } from "./blocks";
import { groupToolStreaks, type GroupedItem } from "./utils/groupTools";
import { match } from "ts-pattern";

import { cn } from "@/shared/lib/utils";
import { Copy, ChevronDown, ChevronUp } from "lucide-react";
import { ActionButton } from "./ActionButton";
import { useCopyToClipboard } from "@/shared/hooks";
import { useSession } from "../context";
import { useMemo, memo, useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";

// Import tool registry initialization (registers all tools)
import "./tools/registerTools";

const COLLAPSE_MAX_HEIGHT = 144;

type ParsedContent = (ContentBlock | string)[] | string;

interface MessageItemProps {
  message: Message;
  isLatestAssistant?: boolean; // Whether this is the latest assistant message (for auto-expanding)
  isLastInTurn?: boolean; // Whether this is the last message in its assistant turn
  isWorking?: boolean; // Whether AI is currently working
  isStreamingTurn?: boolean; // Whether this message belongs to the turn currently being generated
}

export const MessageItem = memo(function MessageItem({
  message,
  isLatestAssistant = false,
  isLastInTurn = false,
  isWorking = false,
  isStreamingTurn = false,
}: MessageItemProps) {
  const { parseContent } = useSession();
  const { copy, copied } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Parse message content (memoized to avoid re-parsing JSON on every render)
  const contentBlocks = useMemo(
    () => parseContent(message.content),
    [message.content, parseContent]
  );

  // Separate image blocks from text/other blocks for grouped rendering (user messages only)
  // Images render in a horizontal row above the collapsible text content
  const { imageBlocks, otherBlocks } = useMemo(() => {
    if (message.role !== "user" || !Array.isArray(contentBlocks)) {
      return { imageBlocks: [] as ContentBlock[], otherBlocks: contentBlocks };
    }
    const images: ContentBlock[] = [];
    const others: (ContentBlock | string)[] = [];
    for (const block of contentBlocks as (ContentBlock | string)[]) {
      if (isImageBlock(block)) {
        images.push(block);
      } else {
        others.push(block);
      }
    }
    return { imageBlocks: images, otherBlocks: others as ParsedContent };
  }, [message.role, contentBlocks]);

  const hasTextContent = Array.isArray(otherBlocks)
    ? (otherBlocks as (ContentBlock | string)[]).length > 0
    : otherBlocks != null;

  // Check if content should be collapsible (user messages only, uses theme constants)
  useEffect(() => {
    if (message.role === "user" && contentRef.current) {
      const actualHeight = contentRef.current.scrollHeight;
      setShouldCollapse(actualHeight > COLLAPSE_MAX_HEIGHT);
    }
  }, [message.role, contentBlocks]);

  // Extract text content for copy functionality
  const extractTextContent = (): string => {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(contentBlocks)) {
      return contentBlocks
        .map((block: ContentBlock | string) => {
          if (typeof block === "string") return block;
          if (isTextBlock(block)) return block.text;
          return "";
        })
        .join("\n");
    }
    return String(message.content);
  };

  const handleCopy = () => {
    copy(extractTextContent());
  };

  // Helper: Render content blocks with proper keys (DRY - used for both user/assistant)
  const renderContentBlocks = (blocks: (ContentBlock | string)[]) => {
    return blocks.map((block: ContentBlock | string, index: number) => {
      // Generate unique key: use tool_use id if available, otherwise fallback to index
      const key = isToolUseBlock(block) ? block.id : `${message.id}:${index}`;

      // A text block is "streaming" when it is the last text block in the last
      // message of the actively-streaming turn. Everything else = full opacity.
      const isBlockStreaming = isStreamingTurn && isLastInTurn && index === lastTextBlockIndex;

      return (
        <BlockRenderer
          key={key}
          block={block}
          index={index}
          role={message.role}
          isStreaming={isBlockStreaming}
        />
      );
    });
  };

  /**
   * MESSAGE FILTERING NOTE
   *
   * Filtering is now handled in Chat.tsx before messages reach this component.
   * Messages with only tool_result blocks or empty content are filtered out upstream.
   * This ensures we don't create wrapper divs with incorrect margins for empty messages.
   *
   * WHY: In Claude's message format, tool_result blocks are not rendered as standalone messages.
   * Instead, they are linked to their corresponding tool_use blocks via the toolResultMap.
   * See BlockRenderer.tsx for how tool_use blocks retrieve and display their results.
   *
   * ARCHITECTURE: This follows the BlockRenderer pattern where:
   * 1. tool_use blocks are rendered with their input parameters
   * 2. tool_result blocks are fetched via toolResultMap and displayed inline with tool_use
   * 3. Messages with only tool_result are filtered in Chat.tsx (won't reach this component)
   *
   * If you see messages not displaying, check:
   * 1. Chat.tsx - ensure filtering logic is correct
   * 2. BlockRenderer.tsx - ensure tool_use blocks fetch results from toolResultMap
   * 3. session.queries.ts - ensure toolResultMap is built correctly
   * 4. Backend API - ensure messages have correct content structure
   */

  // Determine role-based styling
  const roleStyles =
    message.role === "user"
      ? {
          container:
            "ml-auto w-fit bg-accent hover:bg-accent/80 backdrop-blur-sm transition-colors duration-200 ease-out motion-reduce:transition-none",
          text: "font-normal",
          textColor: "text-foreground",
          maxWidth: "max-w-[85%]",
          shape: "rounded-xl",
          padding: "px-3 py-2",
        }
      : { container: "mr-auto", maxWidth: "max-w-full" };

  // Find last text block index — used to identify which block is actively streaming.
  // Only the last text block in the last message of the streaming turn gets dimmed.
  let lastTextBlockIndex = -1;
  if (Array.isArray(contentBlocks) && message.role === "assistant") {
    const blocks = contentBlocks as (ContentBlock | string)[];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (typeof block === "string" || isTextBlock(block)) {
        lastTextBlockIndex = i;
        break;
      }
    }
  }

  // Group consecutive read-only tool blocks for compact rendering.
  // During streaming, trailing streaks render individually (isSealed=false).
  // When text follows or the turn completes, they collapse into a header.
  const groupedBlocks = useMemo(() => {
    if (message.role !== "assistant" || !Array.isArray(contentBlocks)) return null;
    return groupToolStreaks(contentBlocks as (ContentBlock | string)[]);
  }, [message.role, contentBlocks]);

  // ── Parts-based rendering (new unified model) ──────────────────────
  // If the assistant message has parts from the parts table, render from
  // those instead of parsing the legacy content JSON. This is the primary
  // rendering path for new messages; legacy content is the fallback for
  // historical messages that predate the parts migration.
  const hasParts = message.role === "assistant" && message.parts && message.parts.length > 0;

  if (hasParts) {
    return (
      <div
        key={message.id}
        className={cn(
          "group relative",
          roleStyles.maxWidth,
          roleStyles.container,
          "flex min-w-0 flex-col gap-2 overflow-x-hidden",
          "transition-colors duration-100 ease-in motion-reduce:transition-none"
        )}
      >
        <PartsRenderer parts={message.parts!} isStreamingTurn={isStreamingTurn && isLastInTurn} />
      </div>
    );
  }

  // ── Legacy content-based rendering (fallback) ─────────────────────
  // Skip rendering if assistant message has no content and no parts
  // (message.created was received but parts haven't arrived yet)
  if (message.role === "assistant" && !message.content) {
    return null;
  }

  // Assistant messages - grouped tool streaks + individual blocks
  if (message.role === "assistant") {
    return (
      <div
        key={message.id}
        className={cn(
          "group relative",
          roleStyles.maxWidth,
          roleStyles.container,
          "flex min-w-0 flex-col gap-2 overflow-x-hidden",
          "transition-colors duration-100 ease-in motion-reduce:transition-none"
        )}
      >
        {groupedBlocks ? (
          groupedBlocks.map((item: GroupedItem) =>
            match(item)
              .with({ kind: "single" }, (s) => {
                const { block, originalIndex } = s;
                const key = isToolUseBlock(block) ? block.id : `${message.id}:${originalIndex}`;
                const isBlockStreaming =
                  isStreamingTurn && isLastInTurn && originalIndex === lastTextBlockIndex;
                return (
                  <BlockRenderer
                    key={key}
                    block={block}
                    index={originalIndex}
                    role="assistant"
                    isStreaming={isBlockStreaming}
                  />
                );
              })
              .with({ kind: "streak" }, (s) => {
                // Trailing streaks stay open during streaming, collapse when sealed
                const isSealed = !s.isTrailing || !(isLatestAssistant && isWorking);
                return (
                  <ToolGroupBlock key={s.blocks[0].id} blocks={s.blocks} isSealed={isSealed} />
                );
              })
              .exhaustive()
          )
        ) : (
          // Fallback for non-array content
          <div className="text-base leading-relaxed">
            {typeof contentBlocks === "string"
              ? contentBlocks
              : JSON.stringify(contentBlocks, null, 2)}
          </div>
        )}
      </div>
    );
  }

  // User messages - iMessage style bubble, aligned right
  return (
    <div key={message.id} className="group relative flex flex-col items-end">
      {/* Message card */}
      <div
        className={cn(
          roleStyles.maxWidth,
          roleStyles.container,
          "relative rounded-xl",
          "px-3 py-2",
          "min-w-0"
        )}
      >
        {/* Copy button — top-right inside the bubble, icon-only */}
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
        {/* Image thumbnails — always visible, not affected by collapse */}
        {imageBlocks.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", hasTextContent && "mb-2")}>
            {imageBlocks.map((block, idx) => (
              <BlockRenderer
                key={`${message.id}:img:${idx}`}
                block={block}
                index={idx}
                role="user"
              />
            ))}
          </div>
        )}

        {/* Text content — collapsible for long messages with animated height */}
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
            {Array.isArray(otherBlocks) ? (
              renderContentBlocks(otherBlocks as (ContentBlock | string)[])
            ) : (
              <div className={cn("text-sm leading-relaxed", roleStyles.text)}>
                {typeof otherBlocks === "string"
                  ? otherBlocks
                  : JSON.stringify(otherBlocks, null, 2)}
              </div>
            )}

            {/* Fade overlay for collapsed state - matches user message bg-accent */}
            {shouldCollapse && !isExpanded && (
              <div className="from-accent via-accent/60 pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t to-transparent" />
            )}
          </motion.div>
        )}

        {/* Show more/less button */}
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
