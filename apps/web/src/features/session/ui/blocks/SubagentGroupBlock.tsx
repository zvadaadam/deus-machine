/**
 * Subagent Group Block
 *
 * Collapsible container for a single subagent (Task tool_use) that shows
 * the agent's internal work — tool calls, text, thinking — grouped together.
 *
 * Visual pattern matches BaseToolRenderer (same px-2 py-1.5, icon, chevron)
 * but renders child messages via SubagentMessageList instead of raw tool content.
 *
 * Header: Cpu icon + description + subagent_type badge + tool count + status
 * - Always starts collapsed (user controls expand/collapse)
 * - Spinner stays visible during hover when running (no chevron swap)
 */

import { useState, useMemo } from "react";
import { ChevronRight, Cpu, Loader2 } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock, ToolResultBlock, Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";

import { SubagentMessageList } from "./SubagentMessageList";
import { useSession } from "../../context";

interface SubagentGroupBlockProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  childMessages: Message[];
}

const expandTransition = { duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const };

export function SubagentGroupBlock({
  toolUse,
  toolResult,
  childMessages,
}: SubagentGroupBlockProps) {
  const { parseContent, sessionStatus } = useSession();
  const { description, subagent_type } = toolUse.input ?? {};

  // Agent-server only persists assistant messages — tool_results for Task blocks
  // are never saved to DB. Use sessionStatus as the completion signal instead.
  const isRunning = sessionStatus === "working" && !toolResult;
  const isError = toolResult?.is_error;

  // Always start collapsed — let the user decide when to expand.
  // No auto-expand on spawn, no auto-collapse on completion.
  const [isExpanded, setIsExpanded] = useState(false);

  // Count tool calls across child messages for the summary
  const toolCount = useMemo(() => {
    let count = 0;
    childMessages.forEach((msg) => {
      const blocks = parseContent(msg.content);
      if (!Array.isArray(blocks)) return;
      blocks.forEach((b: ContentBlock | string) => {
        if (typeof b === "object" && b?.type === "tool_use") count++;
      });
    });
    return count;
  }, [childMessages, parseContent]);

  return (
    <div className="flex flex-col gap-1">
      {/* Header — matches BaseToolRenderer alignment exactly.
          Uses CSS group hover instead of React state for icon swap (no re-renders). */}
      <button
        type="button"
        onClick={() => {
          setIsExpanded(!isExpanded);
        }}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-150 ease-out",
          "opacity-80 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} agent: ${description || "subagent"}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Icon container — 14x14px.
              When running: spinner always visible (no chevron swap on hover).
              When idle: icon/chevron swap on hover like BaseToolRenderer. */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            {isRunning ? (
              <Loader2 className="text-muted-foreground/70 h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                {/* Cpu icon — hides on hover or expanded */}
                <div
                  className={cn(
                    "absolute top-0 left-0 transition-opacity duration-150 ease-out",
                    isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                  )}
                >
                  <Cpu className="text-muted-foreground/70 h-3.5 w-3.5" />
                </div>

                {/* Chevron — shows on hover or expanded */}
                <ChevronRight
                  className={cn(
                    "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                    isExpanded && "rotate-90",
                    isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  aria-hidden="true"
                />
              </>
            )}
          </div>

          {/* Description */}
          <span className="text-muted-foreground truncate font-medium">
            {description || "Agent"}
          </span>

          {/* Subagent type badge */}
          {subagent_type && (
            <span className="bg-muted text-muted-foreground/70 text-2xs flex-shrink-0 rounded-md px-1.5 py-0.5 font-mono leading-none">
              {subagent_type}
            </span>
          )}

          {/* Tool count summary (collapsed only) */}
          {!isExpanded && toolCount > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">
                ·
              </span>
              <span className="text-muted-foreground truncate">
                <NumberFlow
                  value={toolCount}
                  suffix={toolCount !== 1 ? " tool calls" : " tool call"}
                />
              </span>
            </>
          )}

          {/* Error status */}
          {isError && <span className="text-destructive/70 font-normal">Error</span>}
        </div>
      </button>

      {/* Expanded content — AnimatePresence for smooth height + opacity transition.
          SubagentMessageList mounts/unmounts on toggle. Eliminates DOM bloat
          from always-mounted recursive message trees. */}
      <AnimatePresence initial={false}>
        {isExpanded && childMessages.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={expandTransition}
            style={{ overflow: "hidden" }}
            className="mt-0.5 ml-6"
          >
            <SubagentMessageList messages={childMessages} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
