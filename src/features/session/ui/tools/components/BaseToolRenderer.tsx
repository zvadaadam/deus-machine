/**
 * Base Tool Renderer
 *
 * Shared component for all tool renderers. Handles common UI patterns:
 * - Expand/collapse header with animation
 * - Status indicators (success/error/pending)
 * - Error display
 * - Consistent styling and accessibility
 *
 * Tool-specific renderers only need to provide unique content via renderContent prop.
 *
 * Benefits:
 * - Change header design once → affects all 15 tools
 * - Change animations once → affects all 15 tools
 * - Add features (keyboard shortcuts, pinning) once → affects all 15 tools
 * - Guaranteed consistency across all tools
 */

import { useState, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolUse, ToolResult } from '@/shared/types';
import { ToolError } from './ToolError';
import { shouldExpandByDefault } from '../constants';

export interface BaseToolRendererProps {
  // Identity
  toolName: string;
  icon: ReactNode;

  // Data
  toolUse: ToolUse;
  toolResult?: ToolResult;

  // Behavior
  defaultExpanded?: boolean; // Auto-computed from constants if not provided

  // Styling
  borderColor?: 'default' | 'success' | 'error' | 'info' | 'warning';
  backgroundColor?: string; // Optional custom background

  // Content slots
  renderContent: (props: { toolUse: ToolUse; toolResult?: ToolResult; isExpanded: boolean }) => ReactNode;
  renderSummary?: (props: { toolUse: ToolUse }) => ReactNode; // Shown when collapsed in header
  renderMetadata?: (props: { toolUse: ToolUse }) => ReactNode; // Shown below header (e.g., file path)

  // Hooks for custom behavior
  onExpand?: () => void;
  onCollapse?: () => void;
}

export function BaseToolRenderer({
  toolName,
  icon,
  toolUse,
  toolResult,
  defaultExpanded,
  borderColor = 'default',
  backgroundColor,
  renderContent,
  renderSummary,
  renderMetadata,
  onExpand,
  onCollapse,
}: BaseToolRendererProps) {
  // Auto-detect from constants if not provided
  const initialExpanded = defaultExpanded ?? shouldExpandByDefault(toolName);
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  const isError = toolResult?.is_error;

  // Toggle handler
  const handleToggle = () => {
    const newState = !isExpanded;
    setIsExpanded(newState);
    newState ? onExpand?.() : onCollapse?.();
  };

  // Get border color class
  const getBorderColorClass = () => {
    if (isError) return chatTheme.blocks.tool.borderLeft.error;

    switch (borderColor) {
      case 'success':
        return chatTheme.blocks.tool.borderLeft.success;
      case 'error':
        return chatTheme.blocks.tool.borderLeft.error;
      case 'info':
        return chatTheme.blocks.tool.borderLeft.info;
      case 'warning':
        return chatTheme.blocks.tool.borderLeft.error; // Use destructive for warning
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
        onClick={handleToggle}
        className={cn(
          chatTheme.blocks.tool.header,
          'w-full text-left hover:bg-muted/50 p-2 rounded transition-colors justify-between',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${toolName} tool details`}
      >
        {/* Left side: Icon + Label + Summary */}
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

          {/* Summary when collapsed (optional) */}
          {!isExpanded && renderSummary && (
            <span className="text-xs text-muted-foreground ml-2 truncate">
              {renderSummary({ toolUse })}
            </span>
          )}
        </div>

        {/* Right side: Status indicator */}
        {status && (
          <span className={status.className}>
            {status.text}
          </span>
        )}
      </button>

      {/* Metadata (file path, pattern, etc.) - Always Visible */}
      {renderMetadata && (
        <div className="px-2">
          {renderMetadata({ toolUse })}
        </div>
      )}

      {/* Expandable Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }} // ease-out-cubic
            className="overflow-hidden"
          >
            {/* Tool-specific content */}
            <div className="px-2 pb-2">
              {renderContent({ toolUse, toolResult, isExpanded })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Display - Always Visible When Error */}
      {isError && toolResult && (
        <ToolError content={toolResult.content} />
      )}
    </div>
  );
}
