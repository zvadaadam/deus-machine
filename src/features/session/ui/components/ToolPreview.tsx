/**
 * Tool Preview Component
 *
 * Displays tool calls as scannable action cards with icon + verb + preview.
 * Follows the design principle: "What did Claude do, and what was the impact?"
 *
 * States:
 * 1. Inline (default): Single line with icon, verb, and preview stats
 * 2. Expanded: Shows full tool content
 *
 * Design reference: CHAT_REDESIGN.md
 */

import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { ToolUseBlock, ToolResultBlock } from '@/shared/types';

export interface ToolPreviewData {
  icon: React.ComponentType<{ className?: string }>;
  verb: string;
  preview: string;
  stats?: string;
  borderColor: 'primary' | 'warning' | 'success' | 'muted' | 'purple';
}

interface ToolPreviewProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  previewData: ToolPreviewData;
  defaultExpanded?: boolean;
  /** Full tool content renderer (the existing tool renderer) */
  fullContent: React.ReactNode;
}

const borderColorClasses = {
  primary: 'border-l-primary/30',
  warning: 'border-l-amber-500/30',
  success: 'border-l-green-500/30',
  purple: 'border-l-purple-500/30',
  muted: 'border-l-border/20',
};

export function ToolPreview({
  toolUse,
  toolResult,
  previewData,
  defaultExpanded = false,
  fullContent,
}: ToolPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const Icon = previewData.icon;

  // Check if tool has error
  const hasError = toolResult?.is_error ||
    (Array.isArray(toolResult?.content) &&
     toolResult.content[0]?.type === 'text' &&
     typeof toolResult.content[0].text === 'string' &&
     toolResult.content[0].text.includes('error'));

  return (
    <div className="w-full">
      {/* Inline Preview */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5',
          'rounded-md border border-border/20 border-l-2',
          'bg-transparent hover:bg-muted/20',
          'transition-all duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'text-left group',
          borderColorClasses[previewData.borderColor],
          hasError && 'border-l-destructive/30'
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

        {/* Tool Icon */}
        <div className="flex-shrink-0">
          <Icon className={cn(
            'w-4 h-4',
            hasError ? 'text-destructive' : 'text-muted-foreground'
          )} />
        </div>

        {/* Verb + Preview */}
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-foreground">
            {previewData.verb}
          </span>
          <span className="text-[12px] text-muted-foreground truncate">
            {previewData.preview}
          </span>
        </div>

        {/* Stats (if provided) */}
        {previewData.stats && (
          <span className="text-[12px] text-muted-foreground flex-shrink-0">
            {previewData.stats}
          </span>
        )}

        {/* Error Indicator */}
        {hasError && (
          <span className="text-[11px] text-destructive font-medium flex-shrink-0">
            ERROR
          </span>
        )}
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div
          className={cn(
            'mt-1 rounded-md border border-border/40 bg-card',
            'overflow-hidden',
            'animate-in slide-in-from-top-2 duration-200'
          )}
        >
          {fullContent}
        </div>
      )}
    </div>
  );
}
