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

import { useState, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";
import { ToolError } from "./ToolError";

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
  renderContent?: (props: {
    toolUse: ToolUseBlock;
    toolResult?: ToolResultBlock;
    isExpanded: boolean;
  }) => ReactNode; // OLD API
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
  const [isHovered, setIsHovered] = useState(false);
  const isError = toolResult?.is_error;

  // Minimal design: Error-only status (assume success by default)
  const status = isError
    ? { text: "✗ Error", className: "text-destructive text-xs font-medium" }
    : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, no borders or backgrounds */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-200 ease-out",
          "hover:opacity-70",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${toolName} tool details`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Icon container - fixed width to prevent layout shift */}
          <div className="relative h-4 w-4 flex-shrink-0">
            {/* Tool icon - default state (hides on hover or when expanded) */}
            <div
              className={cn(
                "absolute left-0 top-0 transition-opacity duration-50",
                isHovered || isExpanded ? "opacity-0" : "opacity-100"
              )}
            >
              {icon}
            </div>

            {/* Chevron - shows on hover or when expanded (fast like table row hover) */}
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute left-0 top-0 h-4 w-4 transition-all duration-50",
                isExpanded && "rotate-90",
                isHovered || isExpanded ? "opacity-100" : "opacity-0"
              )}
              aria-hidden="true"
            />
          </div>

          {/* Tool name - truncate if too long (reduced weight for hierarchy) */}
          <span className="text-muted-foreground truncate font-normal">{toolName}</span>

          {/* Status indicator (error only) */}
          {status && <span className={status.className}>{status.text}</span>}

          {/* Preview when collapsed */}
          {!isExpanded && renderSummary && (
            <span className="text-muted-foreground truncate text-xs">
              {renderSummary({ toolUse })}
            </span>
          )}
        </div>
      </button>

      {/* Expanded content - indented, no duplication */}
      {isExpanded && (
        <div className="mt-1 ml-5">
          {/* NEW API: children */}
          {children}

          {/* OLD API: renderContent */}
          {!children && renderContent && renderContent({ toolUse, toolResult, isExpanded })}
        </div>
      )}

      {/* Error Display - Always Visible When Error */}
      {isError && toolResult && (
        <div className="mt-1 ml-5">
          <ToolError content={toolResult.content} />
        </div>
      )}
    </div>
  );
}
