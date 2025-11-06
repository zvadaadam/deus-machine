/**
 * Thinking Block
 *
 * Displays Claude's internal reasoning process.
 * Collapsed by default to reduce clutter.
 * Shows encrypted signature status when present.
 */

import type { ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chatTheme } from '../theme';

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Width-based preview: 120 chars
  const PREVIEW_CHAR_LIMIT = 120;
  const preview = block.thinking.length > PREVIEW_CHAR_LIMIT
    ? block.thinking.substring(0, PREVIEW_CHAR_LIMIT) + '...'
    : block.thinking;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, clean */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 text-sm',
          'text-left w-full cursor-pointer',
          'transition-opacity duration-200 hover:opacity-80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      >
        {/* Chevron - subtle and small */}
        <ChevronRight
          className={cn(
            'w-3 h-3 text-muted-foreground/50 transition-transform duration-200 flex-shrink-0',
            isExpanded && 'rotate-90'
          )}
          aria-hidden="true"
        />

        {/* Icon - consistent gray */}
        <Brain className="w-4 h-4 text-muted-foreground/70 flex-shrink-0" />

        {/* Label */}
        <span className="font-medium">Thinking</span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span className="text-muted-foreground italic truncate text-xs">
            {preview}
          </span>
        )}
      </button>

      {/* Expanded: show FULL thinking text */}
      {isExpanded && (
        <div className="ml-5 mt-1 text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {block.thinking}
        </div>
      )}
    </div>
  );
}
