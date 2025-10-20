/**
 * Message Item (New Architecture)
 *
 * Refactored message component using the registry pattern.
 * Uses BlockRenderer for extensible content rendering.
 */

import type { Message } from '@/types';
import { BlockRenderer } from '../blocks';
import { chatTheme } from '../theme';
import { cn } from '@/lib/utils';

interface MessageItemProps {
  message: Message;
  parseContent: (content: string) => any;
}

export function MessageItem({ message, parseContent }: MessageItemProps) {
  // Parse message content
  const contentBlocks = parseContent(message.content);

  // Determine role-based styling
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  const roleStyles = isUser
    ? chatTheme.message.user
    : chatTheme.message.assistant;

  return (
    <div
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
            <BlockRenderer key={index} block={block} index={index} />
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
