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

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
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
  showContentOnError?: boolean; // True for tools whose renderContent already displays error output (e.g. Bash)
  // Content rendering (choose one)
  children?: ReactNode; // NEW API: Single children slot
  renderContent?: (props: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }) => ReactNode; // OLD API
  renderSummary?: () => ReactNode; // Persistent context shown in header
}

const expandTransition = { duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const };

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
  const toggleExpanded = useCallback(() => {
    setManualExpanded(!isExpanded);
  }, [isExpanded]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleExpanded();
    },
    [toggleExpanded]
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5">
      {/* Header - Minimal, no borders or backgrounds.
          Uses CSS group hover for icon swap (no re-renders on mouse enter/leave). */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-150 ease-out",
          "opacity-80 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${toolName} tool details`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Icon container - fixed width to prevent layout shift.
              On error: X icon replaces tool icon (instant scan signal). */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            {/* Tool icon or error X — default state (hides on hover or when expanded) */}
            <div
              className={cn(
                "absolute top-0 left-0 transition-opacity duration-150 ease-out",
                isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
              )}
            >
              {isError ? (
                <X className="text-destructive/70 h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                icon
              )}
            </div>

            {/* Chevron - shows on hover or when expanded */}
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                isExpanded && "rotate-90",
                isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            />
          </div>

          {/* Tool name — shimmer when loading. */}
          <span
            className={cn(
              "flex-shrink-0 font-medium",
              isLoading ? "text-muted-foreground tool-loading-shimmer" : "text-foreground/70"
            )}
          >
            {toolName}
          </span>

          {/* Header context — stays visible when expanded so users keep orientation.
              Wrapped in a truncating span so the row never wraps: rightmost content
              (e.g. command preview) truncates first, then description. */}
          {renderSummary && <span className="min-w-0 flex-1 truncate">{renderSummary()}</span>}
        </div>
      </div>

      {/* Expanded content — AnimatePresence for smooth height + opacity transition. */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={expandTransition}
            style={{ overflow: "hidden" }}
            className="mt-0.5 w-full min-w-0"
          >
            {isError && toolResult && !showContentOnError ? (
              <ToolError content={toolResult.content} />
            ) : (
              <>
                {children}
                {!children && renderContent && renderContent({ toolUse, toolResult })}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
