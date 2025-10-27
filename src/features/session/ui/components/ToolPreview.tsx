/**
 * Tool Preview Component (Minimal Inline Design)
 *
 * Displays tool calls as simple inline list items.
 * Design philosophy: Whisper, don't shout. Tools are secondary to the conversation.
 *
 * States:
 * 1. Collapsed (default): Icon + verb + preview in one line
 * 2. Expanded: Shows full tool content below
 *
 * Jony Ive principle: "Simplicity is the ultimate sophistication"
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

// Subtle accent colors - just for the icon, not borders
const iconColorClasses = {
  primary: 'text-primary/70',
  warning: 'text-amber-600/70',
  success: 'text-green-600/70',
  purple: 'text-purple-600/70',
  muted: 'text-muted-foreground',
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
      {/* Inline Preview - minimal, list-like */}
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

        {/* Tool Icon - colored by type */}
        <div className="flex-shrink-0">
          <Icon className={cn(
            'w-3.5 h-3.5',
            hasError ? 'text-destructive' : iconColorClasses[previewData.borderColor]
          )} />
        </div>

        {/* Verb + Preview - flowing inline */}
        <div className="flex-1 flex items-baseline gap-1.5 min-w-0">
          <span className="text-[13px] text-foreground/90">
            {previewData.verb}
          </span>
          <span className="text-[12px] text-muted-foreground/80 truncate">
            {previewData.preview}
          </span>
        </div>

        {/* Stats - subtle, right-aligned */}
        {previewData.stats && (
          <span className="text-[11px] text-muted-foreground/60 flex-shrink-0 tabular-nums">
            {previewData.stats}
          </span>
        )}

        {/* Error - minimal indicator */}
        {hasError && (
          <span className="text-[10px] text-destructive/80 font-medium flex-shrink-0 uppercase tracking-wider">
            Error
          </span>
        )}
      </button>

      {/* Expanded Content - when user requests details */}
      {isExpanded && (
        <div
          className={cn(
            'mt-1 ml-5 rounded border border-border/30 bg-card/50',
            'overflow-hidden',
            'animate-in slide-in-from-top-1 duration-150'
          )}
        >
          {fullContent}
        </div>
      )}
    </div>
  );
}
