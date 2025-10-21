/**
 * Message Item (Refactored)
 *
 * Uses the new registry pattern with BlockRenderer for extensible content rendering.
 * Automatically imports and registers all tool renderers.
 */

import type { Message } from "@/shared/types";
import type { ToolResultMap } from "./chat-types";
import { BlockRenderer } from "./blocks";
import { chatTheme } from "./theme";
import { cn } from "@/shared/lib/utils";

// Import tool registry initialization (registers all tools)
import "./chat/tools/registerTools";

interface MessageItemProps {
  message: Message;
  parseContent: (content: string) => any;
  toolResultMap: ToolResultMap;
}

export function MessageItem({ message, parseContent, toolResultMap }: MessageItemProps) {
  // Parse message content
  const contentBlocks = parseContent(message.content);

  // Check if message has any renderable content
  // Filter out blocks that BlockRenderer will skip (tool_result)
  const hasRenderableContent = Array.isArray(contentBlocks) &&
    contentBlocks.length > 0 &&
    contentBlocks.some((block: any) => block.type !== 'tool_result');

  // Don't render empty messages (fixes empty assistant messages issue)
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
        <span className="text-[0.7rem] text-muted-foreground/70">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
      </div>

      {/* Message content - uses BlockRenderer */}
      <div className="flex flex-col gap-2">
        {Array.isArray(contentBlocks) ? (
          contentBlocks.map((block: any, index: number) => (
            <BlockRenderer key={index} block={block} index={index} toolResultMap={toolResultMap} role={message.role} />
          ))
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
