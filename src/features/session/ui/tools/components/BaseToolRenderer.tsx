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

  // Get border color class (prioritize explicit prop, then tool metadata, then fallback)
  const getBorderColorClass = () => {
    if (isError) return chatTheme.blocks.tool.borderLeft.error;

    const colorToUse = borderColor || toolMetadata.borderColor;

    switch (colorToUse) {
      case 'primary':
        return chatTheme.blocks.tool.borderLeft.primary;
      case 'success':
        return chatTheme.blocks.tool.borderLeft.success;
      case 'error':
        return chatTheme.blocks.tool.borderLeft.error;
      case 'info':
        return chatTheme.blocks.tool.borderLeft.info;
      case 'warning':
        return chatTheme.blocks.tool.borderLeft.warning;
      default:
        return chatTheme.blocks.tool.borderLeft.default;
    }
  };

  // Get background color
  const getBackgroundColor = () => {
    if (backgroundColor) return backgroundColor;
    if (isError) return 'bg-destructive/5';
    if (borderColor === 'success') return 'bg-success/5';
    return '';
  };

  // Get status text
  const getStatusText = () => {
    if (!toolResult) return null;
    if (isError) return { text: '✗ Failed', className: 'text-destructive text-sm' };
    return { text: '✓ Done', className: 'text-success text-sm' };
  };

  const status = getStatusText();

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        getBorderColorClass(),
        getBackgroundColor()
      )}
    >
      {/* Header - Always Visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          chatTheme.blocks.tool.header,
          'w-full text-left hover:bg-muted/50 p-2 rounded transition-colors justify-between',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${toolName} tool details`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {/* Chevron */}
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          )}

          {/* Tool icon */}
          <div className={chatTheme.blocks.tool.icon}>
            {icon}
          </div>

          {/* Tool name */}
          <strong className="font-semibold">{toolName}</strong>

          {/* Summary when collapsed (OLD API) */}
          {!isExpanded && renderSummary && (
            <span className="text-xs text-muted-foreground ml-2 truncate">
              {renderSummary({ toolUse })}
            </span>
          )}
        </div>

        {/* Status indicator */}
        {status && (
          <span className={status.className}>
            {status.text}
          </span>
        )}
      </button>

      {/* Metadata (file path, pattern, etc.) - OLD API */}
      {renderMetadata && (
        <div className="px-2">
          {renderMetadata({ toolUse })}
        </div>
      )}

      {/* Expandable Content - CSS transition */}
      <div
        className={cn(
          'overflow-hidden overflow-x-auto min-w-0 transition-all duration-200 ease-out',
          isExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        {/* NEW API: children */}
        {children}

        {/* OLD API: renderContent */}
        {!children && renderContent && (
          <div className="px-2 pb-2">
            {renderContent({ toolUse, toolResult, isExpanded })}
          </div>
        )}
      </div>

      {/* Error Display - Always Visible When Error */}
      {isError && toolResult && (
        <ToolError content={toolResult.content} />
      )}
    </div>
  );
}
