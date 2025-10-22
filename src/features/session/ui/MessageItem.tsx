/**
 * Message Item (Refactored)
 *
 * Uses the new registry pattern with BlockRenderer for extensible content rendering.
 * Automatically imports and registers all tool renderers.
 */

import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import type { ToolResultMap } from "./chat-types";
import { BlockRenderer } from "./blocks";
import { chatTheme } from "./theme";
import { cn } from "@/shared/lib/utils";
import { Copy, RotateCcw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useState } from "react";

// Import tool registry initialization (registers all tools)
import "./tools/registerTools";

type ParsedContent = (ContentBlock | string)[] | string | null;

interface MessageItemProps {
  message: Message;
  parseContent: (content: string) => ParsedContent;
  toolResultMap: ToolResultMap;
}

export function MessageItem({ message, parseContent, toolResultMap }: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  // Parse message content
  const contentBlocks = parseContent(message.content);

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

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(extractTextContent());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleRevert = () => {
    // TODO: Implement revert functionality
    console.log('Revert to message:', message.id);
  };

  /**
   * MESSAGE FILTERING LOGIC
   *
   * This component filters out messages that contain ONLY tool_result blocks.
   * This is EXPECTED BEHAVIOR and not a bug.
   *
   * WHY: In Claude's message format, tool_result blocks are not rendered as standalone messages.
   * Instead, they are linked to their corresponding tool_use blocks via the toolResultMap.
   * See BlockRenderer.tsx:44-49 for how tool_use blocks retrieve and display their results.
   *
   * CONSOLE LOGS: You may see thousands of "[MessageItem] Skipping empty message" logs.
   * These are normal and indicate that the filtering is working correctly. They appear when:
   * - A message contains only tool_result blocks (will be displayed linked to tool_use)
   * - A message is truly empty (rare edge case)
   *
   * ARCHITECTURE: This follows the BlockRenderer pattern where:
   * 1. tool_use blocks are rendered with their input parameters
   * 2. tool_result blocks are fetched via toolResultMap and displayed inline with tool_use
   * 3. Messages with only tool_result are skipped (their content appears elsewhere)
   *
   * If you see messages not displaying, check:
   * 1. BlockRenderer.tsx - ensure tool_use blocks fetch results from toolResultMap
   * 2. session.queries.ts - ensure toolResultMap is built correctly
   * 3. Backend API - ensure messages have correct content structure
   */
  const isArray = Array.isArray(contentBlocks);
  const onlyToolResults =
    isArray &&
    contentBlocks.length > 0 &&
    contentBlocks.every((block: ContentBlock) => typeof block === 'object' && block?.type === 'tool_result');
  const isEmpty =
    (isArray && contentBlocks.length === 0) ||
    (!isArray && (contentBlocks == null || String(contentBlocks).trim() === ''));
  const hasRenderableContent = !(onlyToolResults || isEmpty);

  // Skip messages that are empty or contain only tool_result blocks (see comment above)
  if (!hasRenderableContent) {
    if (import.meta.env.DEV) {
      console.log(`[MessageItem] Skipping empty message ${message.id} (${message.role})`);
    }
    return null;
  }

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
        'flex flex-col gap-2 overflow-visible',
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
      <div className="flex flex-col">
        {Array.isArray(contentBlocks) ? (
          contentBlocks.map((block: ContentBlock | string, index: number) => {
            const key = typeof block === 'object' && block?.id ? block.id : `${message.id}:${index}`;
            if (typeof block === 'string') return null;
            return (
              <BlockRenderer key={key} block={block} index={index} toolResultMap={toolResultMap} role={message.role} />
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
}
