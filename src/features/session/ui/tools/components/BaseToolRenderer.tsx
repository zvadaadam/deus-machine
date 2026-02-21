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
  isLoading?: boolean; // True when tool result is pending (shimmer effect)

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
  children,
  renderContent,
  renderSummary,
}: BaseToolRendererProps) {
  const isError = toolResult?.is_error;

  // Manual override: null = derive from data, boolean = user clicked.
  // Auto-expands on error without useEffect (derived state pattern).
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const isExpanded = manualExpanded !== null ? manualExpanded : defaultExpanded || !!isError;

  // Error-only status — subtle, not alarming. Agents encounter errors frequently
  // (build failures, missing files, retries) and continue working. Cursor uses
  // a muted red label inline with the tool name, not a badge or banner.
  const status = isError
    ? { text: "Error", className: "text-destructive/70 text-xs font-normal" }
    : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, no borders or backgrounds.
          Uses CSS group hover for icon swap (no re-renders on mouse enter/leave). */}
      <button
        type="button"
        onClick={() => setManualExpanded(!isExpanded)}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-xs",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-100 ease-in",
          "opacity-80 hover:opacity-100",
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
                "absolute top-0 left-0 transition-opacity duration-100 ease-in",
                isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
              )}
            >
              {icon}
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
              "text-muted-foreground truncate font-normal",
              isLoading ? "tool-loading-shimmer" : "text-foreground/70"
            )}
          >
            {toolName}
          </span>

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

      {/* Expanded content — error lives inside the collapsible body (like Cursor).
          The header "Error" label is the always-visible cue; details are behind the click. */}
      {isExpanded && (
        <div className="mt-0.5 ml-6">
          {/* Error display — inside collapse, not always-visible */}
          {isError && toolResult && <ToolError content={toolResult.content} />}

          {/* NEW API: children */}
          {children}

          {/* OLD API: renderContent */}
          {!children && renderContent && renderContent({ toolUse, toolResult, isExpanded })}
        </div>
      )}
    </div>
  );
}
