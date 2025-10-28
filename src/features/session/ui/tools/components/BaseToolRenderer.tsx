/**
 * Base Tool Renderer (Pure & Minimal)
 *
 * Shared component for all tool renderers with consistent UI patterns:
 * - Expand/collapse with smooth transitions
 * - Error-only status (assume success by default)
 * - Clean, transparent design (no backgrounds or borders)
 * - Supports both new (children) and old (render props) APIs
 *
 * Benefits:
 * - Change header design once → affects all 15 tools
 * - Minimal, content-first aesthetic
 * - Backward compatible with existing tool renderers
 */

import { useState, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { ToolUseBlock, ToolResultBlock } from '@/shared/types';
import { ToolError } from './ToolError';

export interface BaseToolRendererProps {
  // Identity
  toolName: string;
  icon: ReactNode;

  // Data
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;

  // Behavior
  defaultExpanded?: boolean;

  // Content rendering (choose one)
  children?: ReactNode; // NEW API: Single children slot
  renderContent?: (props: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock; isExpanded: boolean }) => ReactNode; // OLD API
  renderSummary?: (props: { toolUse: ToolUseBlock }) => ReactNode; // Preview when collapsed
}

export function BaseToolRenderer({
  toolName,
  icon,
  toolUse,
  toolResult,
  defaultExpanded = false, // Collapsed by default (explicit is better than implicit)
  children,
  renderContent,
  renderSummary,
}: BaseToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const isError = toolResult?.is_error;

  // Minimal design: Error-only status (assume success by default)
  const status = isError
    ? { text: '✗ Error', className: 'text-destructive text-[11px] font-medium' }
    : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Subtle background with left accent border */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-[13px] rounded-lg',
          'bg-muted/40 border-l-2 border-l-primary/60',
          'text-left w-full cursor-pointer',
          'transition-all duration-200 ease-out',
          'hover:bg-muted/60 hover:border-l-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${toolName} tool details`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Chevron - subtle and small */}
          <ChevronRight
            className={cn(
              'w-3 h-3 text-muted-foreground/50 transition-transform duration-200 flex-shrink-0',
              isExpanded && 'rotate-90'
            )}
            aria-hidden="true"
          />

          {/* Tool icon */}
          {icon}

          {/* Tool name */}
          <span className="font-medium">{toolName}</span>

          {/* Status indicator (error only) */}
          {status && (
            <span className={status.className}>
              {status.text}
            </span>
          )}

          {/* Preview when collapsed */}
          {!isExpanded && renderSummary && (
            <span className="truncate text-[12px] text-muted-foreground">
              {renderSummary({ toolUse })}
            </span>
          )}
        </div>
      </button>

      {/* Expanded content - indented, no duplication */}
      {isExpanded && (
        <div className="ml-5 mt-1">
          {/* NEW API: children */}
          {children}

          {/* OLD API: renderContent */}
          {!children && renderContent && renderContent({ toolUse, toolResult, isExpanded })}
        </div>
      )}

      {/* Error Display - Always Visible When Error */}
      {isError && toolResult && (
        <div className="ml-5 mt-1">
          <ToolError content={toolResult.content} />
        </div>
      )}
    </div>
  );
}
