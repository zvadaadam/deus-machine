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

import { Collapse } from "@/components/ui/collapse";
import { useTranscriptFold } from "@/features/session/lib/openChat";
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock, ToolResultBlock } from "../types";
import { ToolError } from "./ToolError";
import { ToolInput, ToolInputSummary } from "./ToolInput";

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

export function BaseToolRenderer({
  toolName,
  icon,
  toolUse,
  toolResult,
  defaultExpanded,
  isLoading = false,
  showContentOnError = false,
  children,
  renderContent,
  renderSummary,
}: BaseToolRendererProps) {
  const isError = toolResult?.is_error;
  const missingResult = !toolResult && !isLoading;

  const [isExpanded, toggleExpanded] = useTranscriptFold("tool", toolUse.id, defaultExpanded);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  }

  function details() {
    if (missingResult) {
      return (
        <div className="space-y-3 px-2 pb-2">
          <ToolInput input={toolUse.input} />
          <div className="text-muted-foreground text-xs italic">No result recorded</div>
        </div>
      );
    }
    if (toolResult?.is_error && !showContentOnError)
      return <ToolError content={toolResult.content} />;
    return children ?? renderContent?.({ toolUse, toolResult });
  }
  const summary = missingResult ? <ToolInputSummary input={toolUse.input} /> : renderSummary?.();

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
          "transition-opacity",
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
                "absolute top-0 left-0 transition-opacity",
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
                "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[rotate,opacity]",
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
          {summary && <span className="min-w-0 flex-1 truncate">{summary}</span>}
        </div>
      </div>

      {/* Expanded content — AnimatePresence for smooth height + opacity transition. */}
      <AnimatePresence initial={false}>
        {isExpanded && <Collapse className="mt-0.5 w-full min-w-0">{details()}</Collapse>}
      </AnimatePresence>
    </div>
  );
}
