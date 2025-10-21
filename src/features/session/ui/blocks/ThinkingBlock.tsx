/**
 * Thinking Block
 *
 * Displays Claude's internal reasoning process.
 * Collapsed by default to reduce clutter.
 * Shows encrypted signature status when present.
 */

import type { ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Shield } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chatTheme } from '../theme';

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const hasSignature = !!block.signature;
  const thinkingPreview = block.thinking.slice(0, 80);
  const showPreview = block.thinking.length > 80;

  return (
    <div
      className={cn(
        'rounded-lg border transition-all duration-200',
        'bg-purple-50/50 dark:bg-purple-950/20',
        'border-purple-200 dark:border-purple-800/40',
        chatTheme.common.transition
      )}
    >
      {/* Header - Always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'w-full flex items-center gap-2 p-3 text-left',
          'hover:bg-purple-100/50 dark:hover:bg-purple-900/20',
          'transition-colors duration-200 rounded-lg'
        )}
      >
        {/* Icon */}
        <Brain className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0" />

        {/* Label */}
        <span className="font-medium text-sm text-purple-700 dark:text-purple-300">
          Thinking
        </span>

        {/* Signature indicator */}
        {hasSignature && (
          <div title="Verified signature">
            <Shield className="w-3 h-3 text-purple-500 dark:text-purple-400 flex-shrink-0" />
          </div>
        )}

        {/* Preview when collapsed */}
        {!isExpanded && showPreview && (
          <span className="text-xs text-purple-600/70 dark:text-purple-400/70 truncate flex-1">
            {thinkingPreview}...
          </span>
        )}

        {/* Expand/collapse icon */}
        <div className="ml-auto flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          )}
        </div>
      </button>

      {/* Content - Only when expanded */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-1">
          <div
            className={cn(
              'text-sm leading-relaxed whitespace-pre-wrap',
              'text-purple-800 dark:text-purple-200',
              'font-mono bg-purple-50 dark:bg-purple-950/40',
              'p-3 rounded border border-purple-200/50 dark:border-purple-800/30'
            )}
          >
            {block.thinking}
          </div>

          {/* Signature info */}
          {hasSignature && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-purple-600/70 dark:text-purple-400/70">
              <Shield className="w-3 h-3" />
              <span>Verified signature present</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
