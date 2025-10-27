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
      {/* Inline Preview - minimal, like a list item */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1',
          'hover:bg-muted/10',
          'transition-colors duration-150',
          'text-left group',
          'rounded'
        )}
        aria-expanded={isExpanded}
      >
        {/* Chevron - subtle, small */}
        <div className="flex-shrink-0 w-3 h-3 text-muted-foreground/60">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </div>

        {/* Brain Icon */}
        <div className="flex-shrink-0">
          <Brain className="w-3.5 h-3.5 text-purple-600/70" />
        </div>

        {/* "Thinking" + Preview - flowing inline */}
        <div className="flex-1 flex items-baseline gap-1.5 min-w-0">
          <span className="text-[13px] text-foreground/90">
            Thinking
          </span>
          <span className="text-[12px] text-muted-foreground/80 truncate italic">
            {preview}
          </span>
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div
          className={cn(
            'mt-1 ml-5 p-3 rounded border border-border/30 bg-card/50',
            'text-[13px] leading-relaxed text-muted-foreground',
            'whitespace-pre-wrap',
            'animate-in slide-in-from-top-1 duration-150'
          )}
        >
          {thinkingText}
        </div>
      )}
    </div>
  );
}
