/**
 * Base Tool Renderer (Simplified with backward compatibility)
 *
 * Shared component for all tool renderers with consistent UI patterns:
 * - Expand/collapse with CSS transitions
 * - Status indicators (success/error/pending)
 * - Error display
 * - Supports both new (children) and old (render props) APIs
 *
 * Benefits:
 * - Change header design once → affects all 15 tools
 * - Consistent animations using CSS (no dependencies)
 * - Backward compatible with existing tool renderers
 */

import { useState, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolUseBlock, ToolResultBlock } from '@/shared/types';
import { ToolError } from './ToolError';
import { shouldExpandByDefault } from '../constants';
import { getToolMetadata } from '../../utils/toolCategories';

export interface BaseToolRendererProps {
  // Identity
  toolName: string;
  icon: ReactNode;

  // Data
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;

  // Behavior
  defaultExpanded?: boolean;

  // Styling (optional overrides)
  borderColor?: 'default' | 'primary' | 'success' | 'error' | 'info' | 'warning';
  backgroundColor?: string;

  // NEW API: Single children slot
  children?: ReactNode;

  // OLD API: Render props (for backward compatibility)
  renderContent?: (props: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock; isExpanded: boolean }) => ReactNode;
  renderSummary?: (props: { toolUse: ToolUseBlock }) => ReactNode;
  renderMetadata?: (props: { toolUse: ToolUseBlock }) => ReactNode;
}

export function BaseToolRenderer({
  toolName,
  icon,
  toolUse,
  toolResult,
  defaultExpanded,
  borderColor,
  backgroundColor,
  children,
  renderContent,
  renderSummary,
  renderMetadata,
}: BaseToolRendererProps) {
  // Get tool metadata for smart defaults
  const toolMetadata = getToolMetadata(toolUse.name);

  // Auto-detect from constants or tool metadata if not provided
  const initialExpanded = defaultExpanded ?? toolMetadata.defaultExpanded;
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  const isError = toolResult?.is_error;

  // Minimal design: Error-only status (assume success by default)
  const status = isError
    ? { text: '✗ Error', className: 'text-destructive text-[11px] font-medium' }
    : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, clean */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 text-[13px]',
          'text-left w-full cursor-pointer',
          'transition-opacity duration-200 hover:opacity-80',
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
