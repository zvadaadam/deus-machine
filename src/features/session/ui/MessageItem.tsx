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

// Import tool registry initialization (registers all tools)
import "./tools/registerTools";

type ParsedContent = ContentBlock[] | string | null;

interface MessageItemProps {
  message: Message;
  parseContent: (content: string) => ParsedContent;
  toolResultMap: ToolResultMap;
}

export function MessageItem({ message, parseContent, toolResultMap }: MessageItemProps) {
  // Parse message content
  const contentBlocks = parseContent(message.content);

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
    contentBlocks.every((block: any) => block?.type === 'tool_result');
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
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  const roleStyles = isUser
    ? chatTheme.message.user
    : chatTheme.message.assistant;

  return (
    <div
      key={message.id}
      className={cn(
        roleStyles.maxWidth,
        roleStyles.container,
        'rounded-xl p-4 flex flex-col gap-3 shadow-sm overflow-hidden',
        chatTheme.common.transition
      )}
    >
      {/* Message header */}
      <div className="flex justify-between items-center gap-3 mb-1">
        <span className="font-semibold uppercase text-xs text-muted-foreground tracking-wide">
          {message.role}
        </span>
        <span className="text-xs text-muted-foreground/70">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
      </div>

      {/* Message content - uses BlockRenderer */}
      <div className="flex flex-col gap-2">
        {Array.isArray(contentBlocks) ? (
          contentBlocks.map((block: any, index: number) => {
            const key = block?.id ?? `${message.id}:${index}`;
            return (
              <BlockRenderer key={key} block={block} index={index} toolResultMap={toolResultMap} role={message.role} />
            );
          })
        ) : (
          // Fallback for non-array content
          <pre className="text-sm font-mono whitespace-pre-wrap">
            {JSON.stringify(contentBlocks, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
