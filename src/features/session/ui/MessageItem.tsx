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
import { Copy, RotateCcw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/shared/hooks";
import { useSession } from "../context";
import { useMemo, memo } from "react";

// Import tool registry initialization (registers all tools)
import "./tools/registerTools";

type ParsedContent = (ContentBlock | string)[] | string | null;

interface MessageItemProps {
  message: Message;
}

export const MessageItem = memo(function MessageItem({ message }: MessageItemProps) {
  const { parseContent, toolResultMap } = useSession();
  const { copy, copied } = useCopyToClipboard();

  // Parse message content (memoized to avoid re-parsing JSON on every render)
  const contentBlocks = useMemo(
    () => parseContent(message.content),
    [message.content, parseContent]
  );

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

  return (
    <div
      key={message.id}
      className={cn(
        'relative group',
        roleStyles.maxWidth,
        roleStyles.container,
        message.role === 'user' ? 'rounded-3xl px-4 py-4' : 'px-0 py-0',
        'flex flex-col gap-2 min-w-0 overflow-x-hidden',
        chatTheme.common.transition
      )}
    >
      {/* Hover action buttons - only for user messages */}
      {message.role === 'user' && (
        <TooltipProvider delayDuration={200}>
          <div className="absolute -top-3 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {/* Copy button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCopy}
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md',
                    'bg-card hover:bg-muted border border-border shadow-sm',
                    'text-muted-foreground hover:text-foreground',
                    'transition-colors duration-200'
                  )}
                  aria-label="Copy message"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{copied ? 'Copied!' : 'Copy Message'}</p>
              </TooltipContent>
            </Tooltip>

            {/* Revert button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleRevert}
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md',
                    'bg-card hover:bg-muted border border-border shadow-sm',
                    'text-muted-foreground hover:text-foreground',
                    'transition-colors duration-200'
                  )}
                  aria-label="Revert to this turn"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Revert to this turn</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}

      {/* Message content - uses BlockRenderer */}
      <div className="flex flex-col min-w-0">
        {Array.isArray(contentBlocks) ? (
          contentBlocks.map((block: ContentBlock | string, index: number) => {
            // Generate unique key: use tool_use id if available, otherwise fallback to index
            const key = typeof block === 'object' && block?.type === 'tool_use'
              ? block.id
              : `${message.id}:${index}`;
            return (
              <BlockRenderer key={key} block={block} index={index} role={message.role} />
            );
          })
        ) : (
          // Fallback for non-array content
          <div className="text-base leading-relaxed">
            {typeof contentBlocks === 'string' ? contentBlocks : JSON.stringify(contentBlocks, null, 2)}
          </div>
        )}
      </div>
    </div>
  );
});
