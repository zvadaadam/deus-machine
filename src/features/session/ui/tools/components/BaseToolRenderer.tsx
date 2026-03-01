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
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { notifyUserExpand } from "@/features/session/hooks/useAutoScroll";
import { anchorAndCorrect, findScrollContainer } from "@/features/session/hooks/useScrollAnchor";
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
  isLoading?: boolean; // True when tool result is pending (shimmer effect)
  showContentOnError?: boolean; // True for tools whose renderContent already displays error output (e.g. Bash)

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
  isLoading = false,
  showContentOnError = false,
  children,
  renderContent,
  renderSummary,
}: BaseToolRendererProps) {
  const isError = toolResult?.is_error;

  // Errors never auto-expand — agents self-correct and errors are transient.
  // The X icon swap on the collapsed row is the error signal; users expand when they want details.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const isExpanded = manualExpanded !== null ? manualExpanded : defaultExpanded;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, no borders or backgrounds.
          Uses CSS group hover for icon swap (no re-renders on mouse enter/leave). */}
      <button
        type="button"
        onClick={(e) => {
          notifyUserExpand();
          const container = findScrollContainer();
          if (container) anchorAndCorrect(e.currentTarget, container);
          setManualExpanded(!isExpanded);
        }}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-100 ease-in",
          "opacity-80 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${toolName} tool details`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Icon container - fixed width to prevent layout shift.
              On error: X icon replaces tool icon (instant scan signal). */}
          <div className="relative h-4 w-4 flex-shrink-0">
            {/* Tool icon or error X — default state (hides on hover or when expanded) */}
            <div
              className={cn(
                "absolute top-0 left-0 transition-opacity duration-100 ease-in",
                isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
              )}
            >
              {isError ? <X className="text-destructive/60 h-4 w-4" aria-hidden="true" /> : icon}
            </div>

            {/* Chevron - shows on hover or when expanded (Cursor: 0.1s ease-in) */}
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute top-0 left-0 h-4 w-4 transition-[transform,opacity] duration-100 ease-in",
                isExpanded && "rotate-90",
                isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            />
          </div>

          {/* Tool name — shimmer when loading (Cursor "make-shine" pattern).
              Cursor uses --cursor-text-secondary for tool names, 12px/400. */}
          <span
            className={cn(
              "text-muted-foreground flex-shrink-0 font-normal",
              isLoading ? "tool-loading-shimmer" : "text-foreground/70"
            )}
          >
            {toolName}
          </span>

          {/* Preview when collapsed */}
          {!isExpanded && renderSummary && (
            <span className="text-muted-foreground truncate">
              {renderSummary({ toolUse })}
            </span>
          )}
        </div>
      </button>

      {/* Expanded content:
          - Error + showContentOnError (Bash): renderer handles error display, skip ToolError
          - Error + !showContentOnError (Edit): show ToolError only, skip renderer content
          - No error: show renderer content normally */}
      {isExpanded && (
        <div className="mt-0.5 ml-6">
          {isError && toolResult && !showContentOnError ? (
            <ToolError content={toolResult.content} />
          ) : (
            <>
              {children}
              {!children && renderContent && renderContent({ toolUse, toolResult, isExpanded })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
