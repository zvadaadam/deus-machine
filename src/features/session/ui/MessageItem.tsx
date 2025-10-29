/**
 * Message Item (Refactored)
 *
 * Uses the new registry pattern with BlockRenderer for extensible content rendering.
 * Automatically imports and registers all tool renderers.
 */

import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { BlockRenderer } from "./blocks";
import { chatTheme } from "./theme";
import { cn } from "@/shared/lib/utils";
import { Copy, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { ActionButton } from "./ActionButton";
import { useCopyToClipboard } from "@/shared/hooks";
import { useSession } from "../context";
import { useMemo, memo, useState, useRef, useEffect } from "react";

// Import tool registry initialization (registers all tools)
import "./tools/registerTools";

type ParsedContent = (ContentBlock | string)[] | string | null;

interface MessageItemProps {
  message: Message;
  isLatestAssistant?: boolean; // Whether this is the latest assistant message
}

export const MessageItem = memo(function MessageItem({ message, isLatestAssistant = false }: MessageItemProps) {
  const { parseContent, toolResultMap } = useSession();
  const { copy, copied } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Parse message content (memoized to avoid re-parsing JSON on every render)
  const contentBlocks = useMemo(
    () => parseContent(message.content),
    [message.content, parseContent]
  );

  // Check if content should be collapsible (user messages only, uses theme constants)
  useEffect(() => {
    if (message.role === 'user' && contentRef.current) {
      const actualHeight = contentRef.current.scrollHeight;
      setShouldCollapse(actualHeight > chatTheme.collapse.maxHeight);
    }
  }, [message.role, contentBlocks]);

  // Extract text content for copy functionality
  const extractTextContent = (): string => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(contentBlocks)) {
      return contentBlocks
        .map((block: ContentBlock | string) => {
          if (typeof block === 'string') return block;
          if (block?.type === 'text') return block.text;
          return '';
        })
        .join('\n');
    }
    return String(message.content);
  };

  const handleCopy = () => {
    copy(extractTextContent());
  };

  const handleRevert = () => {
    // TODO: Implement revert functionality
    console.log('Revert to message:', message.id);
  };

  // Helper: Render content blocks with proper keys (DRY - used for both user/assistant)
  const renderContentBlocks = (blocks: (ContentBlock | string)[]) => {
    return blocks.map((block: ContentBlock | string, index: number) => {
      // Generate unique key: use tool_use id if available, otherwise fallback to index
      const key = typeof block === 'object' && block?.type === 'tool_use'
        ? block.id
        : `${message.id}:${index}`;

      // Determine if this is the last text block (for assistant weight styling)
      const isLastTextBlock = message.role === 'assistant' && index === lastTextBlockIndex;

      return (
        <BlockRenderer
          key={key}
          block={block}
          index={index}
          role={message.role}
          isLastTextBlock={isLastTextBlock}
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
  const roleStyles = message.role === 'user'
    ? chatTheme.message.user
    : chatTheme.message.assistant;

  // Find last text block index for weight (assistant messages only)
  const findLastTextBlockIndex = (blocks: (ContentBlock | string)[]) => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (typeof block === 'string' || (typeof block === 'object' && block?.type === 'text')) {
        return i;
      }
    }
    return -1;
  };

  const lastTextBlockIndex = Array.isArray(contentBlocks) && message.role === 'assistant'
    ? findLastTextBlockIndex(contentBlocks as (ContentBlock | string)[])
    : -1;

  // Assistant messages - use BlockRenderer with weight
  if (message.role === 'assistant') {
    return (
      <div
        key={message.id}
        className={cn(
          'relative group',
          roleStyles.maxWidth,
          roleStyles.container,
          'flex flex-col gap-2 min-w-0 overflow-x-hidden',
          chatTheme.common.transition
        )}
      >
        {Array.isArray(contentBlocks) ? (
          renderContentBlocks(contentBlocks as (ContentBlock | string)[])
        ) : (
          // Fallback for non-array content
          <div className="text-base leading-relaxed">
            {typeof contentBlocks === 'string' ? contentBlocks : JSON.stringify(contentBlocks, null, 2)}
          </div>
        )}
      </div>
    );
  }

  // User messages - refined design with absolutely positioned actions
  return (
    <div key={message.id} className="relative group flex flex-col items-end mb-8">
      {/* Message card */}
      <div
        className={cn(
          roleStyles.maxWidth,
          roleStyles.container,
          chatTheme.message.user.shape,
          chatTheme.message.user.padding,
          'min-w-0'
        )}
      >
        {/* Message content */}
        <div
          ref={contentRef}
          id={`message-content-${message.id}`}
          className={cn(
            'min-w-0',
            // Collapse long messages (using theme constant)
            shouldCollapse && !isExpanded && 'max-h-[168px] overflow-hidden relative'
          )}
        >
          {Array.isArray(contentBlocks) ? (
            renderContentBlocks(contentBlocks as (ContentBlock | string)[])
          ) : (
            // Fallback for non-array content
            <div className={cn('text-[14px] leading-[1.6]', roleStyles.text)}>
              {typeof contentBlocks === 'string' ? contentBlocks : JSON.stringify(contentBlocks, null, 2)}
            </div>
          )}

          {/* Fade overlay for collapsed state - subtle gradient */}
          {shouldCollapse && !isExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-muted via-muted/60 to-transparent pointer-events-none" />
          )}
        </div>

        {/* Show more/less button */}
        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className={chatTheme.expandToggle.button}
            aria-expanded={isExpanded}
            aria-controls={`message-content-${message.id}`}
          >
            {isExpanded ? (
              <>
                Show less
                <ChevronUp className={chatTheme.expandToggle.icon} />
              </>
            ) : (
              <>
                Show more
                <ChevronDown className={chatTheme.expandToggle.icon} />
              </>
            )}
          </button>
        )}
      </div>

      {/* Action buttons - below the card */}
      <div className={chatTheme.userActions.container}>
        <ActionButton
          icon={Copy}
          label={copied ? 'Copied' : 'Copy'}
          onClick={handleCopy}
          active={copied}
        />
        {/* TODO: Enable Revert button when functionality is implemented */}
        {/* <ActionButton
          icon={RotateCcw}
          label="Revert"
          onClick={handleRevert}
        /> */}
      </div>
    </div>
  );
});
