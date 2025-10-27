/**
 * Thinking Preview Component
 *
 * Special preview for thinking blocks - shows icon + "Thinking" + first sentence
 * Always shows first line by default for scannability
 *
 * Design reference: CHAT_REDESIGN.md - Thinking Tool
 */

import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { ThinkingBlock as ThinkingBlockType } from '@/shared/types';

interface ThinkingPreviewProps {
  block: ThinkingBlockType;
  defaultExpanded?: boolean;
}

export function ThinkingPreview({ block, defaultExpanded = false }: ThinkingPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const thinkingText = block.thinking || '';

  // Extract first sentence (up to 60 chars or first period)
  const firstSentenceMatch = thinkingText.match(/^.{1,60}[.!?]?/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0] : thinkingText.substring(0, 60);
  const preview = firstSentence + (thinkingText.length > 60 ? '...' : '');

  return (
    <div className="w-full">
      {/* Inline Preview - Always shows first line */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5',
          'rounded-md border border-border/20 border-l-2 border-l-purple-500/30',
          'bg-transparent hover:bg-muted/20',
          'transition-all duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'text-left group'
        )}
        aria-expanded={isExpanded}
      >
        {/* Expand/Collapse Icon */}
        <div className="flex-shrink-0 w-4 h-4 text-muted-foreground">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </div>

        {/* Brain Icon */}
        <div className="flex-shrink-0">
          <Brain className="w-4 h-4 text-purple-500" />
        </div>

        {/* "Thinking" + Preview */}
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-foreground">
            Thinking
          </span>
          <span className="text-[12px] text-muted-foreground truncate">
            {preview}
          </span>
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div
          className={cn(
            'mt-1 p-3 rounded-md border border-border/40 bg-card',
            'text-[13px] leading-relaxed text-muted-foreground',
            'whitespace-pre-wrap',
            'animate-in slide-in-from-top-2 duration-200'
          )}
        >
          {thinkingText}
        </div>
      )}
    </div>
  );
}
